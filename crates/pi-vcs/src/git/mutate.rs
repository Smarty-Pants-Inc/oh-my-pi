//! In-process local Git mutations.

use std::{
	collections::{BTreeMap, BTreeSet},
	ffi::OsStr,
	fs,
	path::{Path, PathBuf},
	process::{Command, Stdio},
};

use gix::bstr::{BStr, BString, ByteSlice};

use super::{
	GitRepo, normalize_path,
	open::{load_index_or_empty, load_index_or_head, status_with_fresh_index, status_with_index},
	read::literal_pathspec,
};
use crate::{
	error::{Error, Result},
	types::{
		CleanOptions, CommitOptions, DetachGitDirResult, ResetMode, RestoreOptions,
		WorktreeAddOptions, WorktreeAddResult, WorktreeClone,
	},
};

const INDEX_WRITE: gix::index::write::Options = gix::index::write::Options {
	extensions: gix::index::write::Extensions::None,
	skip_hash:  false,
};
/// Apply a ref update, synthesizing a committer for the reflog entry when no
/// identity is configured. Reflog lines require a signature, but git never
/// fails branch/reset/stash ref updates over missing identity — only
/// `git commit` demands one — so parity requires a fallback here.
pub(crate) fn update_reference(
	repo: &gix::Repository,
	op: &'static str,
	name: &str,
	id: gix::hash::ObjectId,
	expected: gix::refs::transaction::PreviousValue,
	message: &str,
	force_create_reflog: bool,
) -> Result<()> {
	let name: gix::refs::FullName = name.try_into().map_err(|err| Error::backend(op, err))?;
	let edit = gix::refs::transaction::RefEdit {
		change: gix::refs::transaction::Change::Update {
			log: gix::refs::transaction::LogChange {
				mode: gix::refs::transaction::RefLog::AndReference,
				force_create_reflog,
				message: message.into(),
			},
			expected,
			new: gix::refs::Target::Object(id),
		},
		name,
		deref: false,
	};
	let now;
	let committer = if let Some(signature) = repo
		.committer()
		.transpose()
		.map_err(|err| Error::backend(op, err))?
	{
		signature
	} else {
		now = format!(
			"{} +0000",
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.map_or(0, |elapsed| elapsed.as_secs())
		);
		gix::actor::SignatureRef {
			name:  "oh-my-pi".into(),
			email: "omp@localhost".into(),
			time:  &now,
		}
	};
	repo
		.edit_references_as(Some(edit), Some(committer))
		.map_err(|err| Error::backend(op, err))?;
	Ok(())
}

impl GitRepo {
	/// Stage worktree files, or every change when `files` is empty.
	///
	/// Empty `files` matches `git add -A`: refresh tracked paths and add
	/// untracked files that survive the standard ignore stack (nested
	/// `.gitignore`, exclude files). When `core.precomposeUnicode` is set,
	/// a worktree path that is a unicode-composition equivalent of an
	/// existing index path (macOS NFD dirent vs NFC index name) is stored
	/// under the index name. Unrelated names that share an inode (hardlinks)
	/// and distinct NFC/NFD files when precompose is off stay separate.
	pub fn stage_files(&self, files: &[String]) -> Result<()> {
		let repo = self.gix_fresh()?;
		let mut index = load_index_or_head(&repo, "git add")?;
		let all = files.is_empty();
		let mut requested: BTreeSet<String> = files
			.iter()
			.map(|path| normalize_stage_path(path))
			.collect();
		for path in &requested {
			if !path.is_empty() {
				ensure_no_symlink_ancestor(self.root(), &self.root().join(path), "git add")?;
			}
		}
		if precompose_unicode_enabled(&repo) {
			requested = remap_composed_index_paths(self.root(), &index, requested);
		}
		let mut selected = collect_stage_paths(&repo, &requested, all)?;
		for entry in index.entries() {
			let path = entry.path(&index);
			if all
				|| requested
					.iter()
					.any(|wanted| stage_path_matches(path, wanted))
			{
				let full = checked_worktree_path(self.root(), path, "git add")?;
				if fs::symlink_metadata(full).is_ok() {
					selected.insert(path.to_owned());
				}
			}
		}
		index.remove_entries(|_, path, _| {
			(all
				|| requested
					.iter()
					.any(|wanted| stage_path_matches(path, wanted)))
				&& !selected.contains(path)
		});
		let (mut pipeline, filter_index) = repo
			.filter_pipeline(None)
			.map_err(|err| Error::backend("git add", err))?;
		for path in selected {
			stage_one(&mut pipeline, &filter_index, self.root(), &mut index, path.as_bstr())?;
		}
		index.sort_entries();
		index
			.write(INDEX_WRITE)
			.map_err(|err| Error::backend("git add", err))
	}

	/// Reset selected index entries to HEAD while preserving the worktree.
	pub fn unstage(&self, files: &[String]) -> Result<()> {
		let repo = self.gix_fresh()?;
		let head = head_tree(&repo, "git reset")?;
		let head_index = index_for_tree(&repo, head.as_ref())?;
		let mut current = load_index_or_head(&repo, "git reset")?;
		copy_index_paths(&mut current, &head_index, files);
		current
			.write(INDEX_WRITE)
			.map_err(|err| Error::backend("git reset", err))
	}

	/// Create a commit and return its object id.
	pub fn commit_create(&self, message: &str, options: &CommitOptions) -> Result<String> {
		let repo = self.gix_fresh()?;
		let mut head = repo
			.head()
			.map_err(|err| Error::backend("git commit", err))?;
		let old_commit = head
			.try_peel_to_id()
			.map_err(|err| Error::backend("git commit", err))?
			.map(|id| id.detach());
		let mut index = load_index_or_head(&repo, "git commit")?;
		if index
			.entries()
			.iter()
			.any(|entry| entry.stage() != gix::index::entry::Stage::Unconflicted)
		{
			return Err(Error::backend("git commit", "cannot commit with unmerged index entries"));
		}
		run_commit_hook(self, &repo, "pre-commit", &[])?;
		index = load_index_or_head(&repo, "git commit")?;
		if index
			.entries()
			.iter()
			.any(|entry| entry.stage() != gix::index::entry::Stage::Unconflicted)
		{
			return Err(Error::backend("git commit", "cannot commit with unmerged index entries"));
		}
		let tree = if options.files.is_empty() {
			write_index_tree(&repo, &index)?
		} else {
			let base = index_for_tree(
				&repo,
				old_commit
					.as_ref()
					.map(|id| commit_tree(&repo, id))
					.transpose()?
					.as_ref(),
			)?;
			let mut partial = base;
			copy_index_paths(&mut partial, &index, &options.files);
			write_index_tree(&repo, &partial)?
		};
		let (parents, inherited_author) = if options.amend {
			let id = old_commit
				.ok_or_else(|| Error::backend("git commit", "cannot amend an unborn HEAD"))?;
			let commit = repo
				.find_commit(id)
				.map_err(|err| Error::backend("git commit", err))?;
			let parents: Vec<gix::hash::ObjectId> =
				commit.parent_ids().map(|id| id.detach()).collect();
			let author = commit
				.author()
				.map_err(|err| Error::backend("git commit", err))?
				.to_owned()
				.map_err(|err| Error::backend("git commit", err))?;
			(parents, Some(author))
		} else {
			(old_commit.into_iter().collect(), None)
		};
		if !options.allow_empty {
			if let Some(parent) = parents.first() {
				if commit_tree(&repo, parent)? == tree {
					return Err(Error::backend("git commit", "nothing to commit, working tree clean"));
				}
			} else if tree == repo.empty_tree().id {
				return Err(Error::backend("git commit", "nothing to commit, working tree clean"));
			}
		}
		let committer = repo
			.committer()
			.ok_or_else(|| Error::backend("git commit", "committer identity is not configured"))?
			.map_err(|err| Error::backend("git commit", err))?;
		let override_author;
		let mut author_time = gix::date::parse::TimeBuf::default();
		let author = if let Some(author) = &options.author {
			let time = match &author.date {
				Some(date) => {
					gix::date::parse(date, None).map_err(|err| Error::backend("git commit", err))?
				},
				None => gix::date::Time::now_local_or_utc(),
			};
			override_author = gix::actor::Signature {
				name: author.name.clone().into(),
				email: author.email.clone().into(),
				time,
			};
			override_author.to_ref(&mut author_time)
		} else if let Some(author) = inherited_author.as_ref() {
			author.to_ref(&mut author_time)
		} else {
			repo
				.author()
				.ok_or_else(|| Error::backend("git commit", "author identity is not configured"))?
				.map_err(|err| Error::backend("git commit", err))?
		};
		let message_path = self.info().git_dir.join("COMMIT_EDITMSG");
		fs::write(&message_path, message)?;
		run_commit_hook(self, &repo, "commit-msg", &[message_path.as_os_str()])?;
		let message = fs::read_to_string(&message_path)
			.map_err(|err| Error::backend("git commit read commit-msg result", err))?;
		let commit = repo
			.new_commit_as(committer, author, message, tree, parents)
			.map_err(|err| Error::backend("git commit", err))?;
		let id = commit.id;
		let expected = old_commit
			.map_or(gix::refs::transaction::PreviousValue::MustNotExist, |old| {
				gix::refs::transaction::PreviousValue::MustExistAndMatch(old.into())
			});
		repo
			.edit_reference(gix::refs::transaction::RefEdit {
				change: gix::refs::transaction::Change::Update {
					log: gix::refs::transaction::LogChange {
						mode:                gix::refs::transaction::RefLog::AndReference,
						force_create_reflog: false,
						message:             if options.amend {
							"commit (amend)"
						} else {
							"commit"
						}
						.into(),
					},
					expected,
					new: gix::refs::Target::Object(id),
				},
				name:   "HEAD"
					.try_into()
					.map_err(|err| Error::backend("git commit", err))?,
				deref:  true,
			})
			.map_err(|err| Error::backend("git commit", err))?;
		let _ = run_commit_hook(self, &repo, "post-commit", &[]);
		Ok(id.to_hex().to_string())
	}

	/// Checkout a branch or detached revision without overwriting local changes.
	pub fn checkout(&self, rev: &str) -> Result<()> {
		let repo = self.gix_fresh()?;
		let (target, symbolic) = resolve_checkout_target(&repo, rev)?;
		checkout_tree(self, &repo, target, false, FilterRef::Set(symbolic.as_deref()))?;
		write_head(self.info().head_path.as_path(), symbolic.as_deref(), target)?;
		Ok(())
	}

	/// Create or force-move a local branch.
	pub fn create_branch(&self, name: &str, start: &str, force: bool) -> Result<()> {
		let repo = self.gix_fresh()?;
		let id = resolve_commit(&repo, start)?;
		let full = format!("refs/heads/{name}");
		if force && branch_is_checked_out(&self.info().common_dir, &full) {
			return Err(Error::backend(
				"git branch",
				format!(
					"cannot force update the branch '{name}' checked out at '{}'",
					self.root().display()
				),
			));
		}
		let constraint = if force {
			gix::refs::transaction::PreviousValue::Any
		} else {
			gix::refs::transaction::PreviousValue::MustNotExist
		};
		update_reference(
			&repo,
			"git branch",
			&full,
			id,
			constraint,
			&format!("branch: Created from {start}"),
			false,
		)?;
		Ok(())
	}

	/// Delete a local branch, returning false for missing or unsafe deletion.
	pub fn delete_branch(&self, name: &str, force: bool) -> Result<bool> {
		let repo = self.gix_fresh()?;
		let full = format!("refs/heads/{name}");
		if branch_is_checked_out(&self.info().common_dir, &full) {
			return Ok(false);
		}
		let Ok(mut reference) = repo.find_reference(&full) else {
			return Ok(false);
		};
		let id = match reference.peel_to_id() {
			Ok(id) => id.detach(),
			Err(_) => return Ok(false),
		};
		if !force {
			let Ok(head) = repo.head_commit() else {
				return Ok(false);
			};
			let mut walk = head
				.ancestors()
				.all()
				.map_err(|err| Error::backend("git branch", err))?;
			let merged = walk.any(|item| item.is_ok_and(|info| info.id == id));
			if !merged {
				return Ok(false);
			}
		}
		let edit = gix::refs::transaction::RefEdit {
			change: gix::refs::transaction::Change::Delete {
				expected: gix::refs::transaction::PreviousValue::MustExistAndMatch(id.into()),
				log:      gix::refs::transaction::RefLog::AndReference,
			},
			name:   full
				.try_into()
				.map_err(|err| Error::backend("git branch", err))?,
			deref:  false,
		};
		Ok(repo.edit_reference(edit).is_ok())
	}

	/// Create a branch at HEAD and switch to it without touching files.
	pub fn checkout_new_branch(&self, name: &str) -> Result<()> {
		self.create_branch(name, "HEAD", false)?;
		fs::write(&self.info().head_path, format!("ref: refs/heads/{name}\n"))?;
		Ok(())
	}

	/// Restore index and/or worktree paths from a selected source.
	pub fn restore(&self, options: &RestoreOptions) -> Result<()> {
		let repo = self.gix_fresh()?;
		let restore_worktree = options.worktree || !options.staged;
		let requested = normalize_restore_paths(&options.files)?;
		let mut index = load_index_or_head(&repo, "git restore")?;
		let original_index =
			(restore_worktree && (options.staged || options.source.is_some())).then(|| index.clone());
		let source_spec = options
			.source
			.as_deref()
			.or_else(|| options.staged.then_some("HEAD"));
		let resolved_source = if let Some(spec) = source_spec {
			let tree = resolve_tree(&repo, spec)?;
			Some((tree, index_for_tree(&repo, Some(&tree))?))
		} else {
			None
		};
		{
			let selected_source = resolved_source
				.as_ref()
				.map_or(&index, |(_, source)| source);
			validate_restore_paths(selected_source, &index, &requested)?;
			reject_sparse_restore(selected_source, &index, &requested)?;
		}

		if options.staged {
			let staged_source = resolved_source
				.as_ref()
				.map(|(_, source)| source)
				.expect("staged restore source was resolved");
			copy_index_paths_selected(&mut index, staged_source, &requested);
		}
		if restore_worktree {
			let source_index = if options.source.is_some() {
				resolved_source
					.as_ref()
					.map(|(_, source)| source)
					.expect("explicit restore source was resolved")
			} else {
				&index
			};
			let tracked_index = original_index.as_ref().unwrap_or(&index);
			let filter_treeish = resolved_source.as_ref().map(|(tree, _)| *tree);
			let filter_ref_name = if options.source.is_some() {
				FilterRef::Set(None)
			} else {
				FilterRef::Keep
			};
			restore_index_paths(
				self.root(),
				&repo,
				source_index,
				tracked_index,
				&requested,
				filter_treeish,
				filter_ref_name,
			)?;
		}
		if options.staged {
			index
				.write(INDEX_WRITE)
				.map_err(|e| Error::backend("git restore", e))?;
		}
		Ok(())
	}

	/// Reset HEAD, index, and optionally the worktree to a target commit.
	pub fn reset(&self, mode: ResetMode, target: Option<&str>) -> Result<()> {
		let repo = self.gix_fresh()?;
		let id = resolve_commit(&repo, target.unwrap_or("HEAD"))?;
		if mode == ResetMode::Hard {
			checkout_tree(self, &repo, id, true, FilterRef::Keep)?;
		} else if mode == ResetMode::Mixed {
			self.read_tree(&id.to_hex().to_string(), None)?;
		}
		update_current_head(&repo, &self.info().head_path, id)?;
		Ok(())
	}

	/// Remove untracked files and directories according to ignore mode.
	pub fn clean(&self, options: &CleanOptions) -> Result<()> {
		// `.` (and `./`) normalize to "" and mean "everything", so they drop out
		// of the restriction set. A literally empty string is rejected the way
		// git rejects it instead of silently widening to the whole worktree.
		let mut paths = BTreeSet::new();
		for raw in &options.paths {
			if raw.is_empty() {
				return Err(Error::backend("git clean", "empty string is not a valid pathspec"));
			}
			let normalized = normalize_stage_path(raw);
			if !normalized.is_empty() {
				paths.insert(normalized);
			}
		}

		// Fresh open: the cached handle snapshots config, so a
		// `core.excludesFile` configured after first use would be missed and
		// its excluded files deleted.
		let repo = self.gix_fresh()?;
		let mut platform =
			status_with_index(&repo, "git clean", load_index_or_head(&repo, "git clean")?)?
				.untracked_files(gix::status::UntrackedFiles::Files);
		let emit_ignored = options.include_ignored || options.ignored_only;
		let for_deletion = if emit_ignored {
			gix::dir::walk::ForDeletionMode::FindNonBareRepositoriesInIgnoredDirectories
		} else {
			gix::dir::walk::ForDeletionMode::IgnoredDirectoriesCanHideNestedRepositories
		};
		platform = platform.dirwalk_options(|opts| {
			let opts = opts
				.emit_empty_directories(true)
				.for_deletion(Some(for_deletion));
			if emit_ignored {
				opts.emit_ignored(Some(gix::dir::walk::EmissionMode::Matching))
			} else {
				opts
			}
		});

		let iter = platform
			.into_index_worktree_iter(
				paths
					.iter()
					.map(|path| literal_pathspec(path).into_bytes().into()),
			)
			.map_err(|e| Error::backend("git clean", e))?;

		for item in iter {
			let item = item.map_err(|e| Error::backend("git clean", e))?;
			let gix::status::index_worktree::Item::DirectoryContents { entry, .. } = item else {
				continue;
			};
			if entry.disk_kind == Some(gix::dir::entry::Kind::Repository) {
				continue;
			}
			let wanted = if options.ignored_only {
				matches!(entry.status, gix::dir::entry::Status::Ignored(_))
			} else if options.include_ignored {
				entry.status == gix::dir::entry::Status::Untracked
					|| matches!(entry.status, gix::dir::entry::Status::Ignored(_))
			} else {
				entry.status == gix::dir::entry::Status::Untracked
			};
			if !wanted {
				continue;
			}
			let full = checked_worktree_path(self.root(), entry.rela_path.as_bstr(), "git clean")?;
			remove_existing(&full)?;
			prune_empty_parents(self.root(), full.parent(), &paths)?;
		}
		Ok(())
	}

	/// Replace an index file with the entries from `treeish`.
	pub fn read_tree(&self, treeish: &str, index_path: Option<&Path>) -> Result<()> {
		let repo = self.gix_fresh()?;
		let tree = resolve_tree(&repo, treeish)?;
		let mut index = repo
			.index_from_tree(&tree)
			.map_err(|e| Error::backend("git read-tree", e))?;
		if let Some(path) = index_path {
			index.set_path(path);
		}
		index
			.write(INDEX_WRITE)
			.map_err(|e| Error::backend("git read-tree", e))
	}

	/// Write an index as a tree object and return its object id.
	pub fn write_tree(&self, index_path: Option<&Path>) -> Result<String> {
		let repo = self.gix()?;
		let index = match index_path {
			Some(path) => gix::index::File::at(path, repo.object_hash(), false, Default::default())
				.map_err(|e| Error::backend("git write-tree", e))?,
			None => repo
				.open_index()
				.map_err(|e| Error::backend("git write-tree", e))?,
		};
		Ok(write_index_tree(&repo, &index)?.to_hex().to_string())
	}

	/// Set one repository-local configuration value while preserving formatting.
	pub fn config_set(&self, key: &str, value: &str) -> Result<()> {
		set_config_file(&self.info().common_dir.join("config"), key, value)
	}

	/// Add a remote idempotently when its URL already matches.
	pub fn remote_add(&self, name: &str, url: &str) -> Result<()> {
		let key = format!("remote.{name}.url");
		let repo = self.gix_fresh()?;
		if let Some(existing) = repo.config_snapshot().string(&key) {
			let existing = existing.to_str_lossy();
			if existing == url {
				return Ok(());
			}
			return Err(Error::backend(
				"git remote add",
				format!("remote {name} already exists with URL {existing}, expected {url}"),
			));
		}
		self.config_set(&key, url)
	}

	/// Create a linked worktree and materialize its checkout.
	pub fn worktree_add(
		&self,
		path: &Path,
		ref_name: &str,
		options: WorktreeAddOptions,
	) -> Result<WorktreeAddResult> {
		let repo = self.gix_fresh()?;
		let id = resolve_commit(&repo, ref_name)?;
		if path.exists() && fs::read_dir(path)?.next().is_some() {
			return Err(Error::backend(
				"git worktree add",
				"destination already exists and is not empty",
			));
		}
		if options.keep_changes {
			let source_head = repo
				.head_id()
				.map_err(|e| Error::backend("git worktree add", e))?
				.detach();
			if source_head != id {
				return Err(Error::backend(
					"git worktree add",
					"keeping uncommitted changes requires the target to be the source HEAD",
				));
			}
		}

		let source_index = load_index_or_head(&repo, "git worktree add")?;
		ensure_sparse_checkout_inactive(&repo, &source_index, "git worktree add")?;
		let target_tree = commit_tree(&repo, &id)?;
		let target_index = repo
			.index_from_tree(&target_tree)
			.map_err(|err| Error::backend("git worktree add", err))?;
		let clone_has_gitlinks =
			index_has_gitlinks(&source_index) || index_has_gitlinks(&target_index);
		if options.keep_changes && clone_has_gitlinks {
			return Err(Error::backend(
				"git worktree add",
				"keeping changes with submodules is not supported safely",
			));
		}

		let head = if options.detach {
			id.to_hex().to_string()
		} else {
			let full = if ref_name.starts_with("refs/heads/") {
				ref_name.to_owned()
			} else {
				format!("refs/heads/{ref_name}")
			};
			if branch_is_checked_out(&self.info().common_dir, &full) {
				return Err(Error::backend(
					"git worktree add",
					format!("'{full}' is already checked out"),
				));
			}
			if repo
				.try_find_reference(&full)
				.map_err(|e| Error::backend("git worktree add", e))?
				.is_none()
			{
				update_reference(
					&repo,
					"git worktree add",
					full.as_str(),
					id,
					gix::refs::transaction::PreviousValue::MustNotExist,
					"branch: Created from worktree add",
					false,
				)?;
			}
			format!("ref: {full}")
		};

		let preferred = if clone_has_gitlinks {
			None
		} else {
			match options.clone {
				WorktreeClone::Off => None,
				WorktreeClone::Auto => Some(None),
				WorktreeClone::Prefer(kind) => Some(Some(kind)),
			}
		};
		let mut clone_error = (clone_has_gitlinks && options.clone != WorktreeClone::Off)
			.then(|| "clone optimization disabled for worktrees containing submodules".to_owned());
		if let Some(preferred) = preferred {
			for kind in pi_iso::clone_candidates(preferred) {
				match self.worktree_add_cloned(path, id, &head, kind, options.keep_changes) {
					Ok(()) => {
						return Ok(WorktreeAddResult { cloned_with: Some(kind), clone_error });
					},
					Err(err) => {
						clone_error = Some(err.to_string());
						cleanup_worktree_add(path, &self.info().common_dir);
					},
				}
			}
		}

		fs::create_dir_all(path)?;
		let admin = register_worktree(path, &self.info().common_dir, &head)?;
		let linked = Self::require(path)?;
		let linked_repo = linked.gix()?;
		checkout_tree(&linked, &linked_repo, id, true, FilterRef::Keep)?;
		if options.keep_changes {
			self.seed_worktree_changes(path, &admin)?;
		}
		Ok(WorktreeAddResult { cloned_with: None, clone_error })
	}

	/// Replicate the source checkout's uncommitted state onto a freshly
	/// materialized worktree at `path`: copy every dirty tracked and
	/// untracked file (deleting what the source deleted), then install the
	/// source index so staged hunks stay staged.
	fn seed_worktree_changes(&self, path: &Path, admin: &Path) -> Result<()> {
		let repo = self.gix_fresh()?;
		let (dirty_tracked, untracked, _) = collect_worktree_changes(&repo, "git worktree add")?;
		for relative in dirty_tracked.iter().chain(untracked.iter()) {
			let src = checked_worktree_path(self.root(), relative.as_bstr(), "git worktree add")?;
			let dst = checked_worktree_path(path, relative.as_bstr(), "git worktree add")?;
			match fs::symlink_metadata(&src) {
				Ok(meta) if meta.file_type().is_symlink() => {
					clear_materialization_path(
						path,
						relative.as_bstr(),
						gix::index::entry::Mode::SYMLINK,
						"git worktree add",
					)?;
					if let Some(parent) = dst.parent() {
						fs::create_dir_all(parent)?;
					}
					copy_symlink(&src, &dst)?;
				},
				Ok(meta) if meta.is_file() => {
					clear_materialization_path(
						path,
						relative.as_bstr(),
						gix::index::entry::Mode::FILE,
						"git worktree add",
					)?;
					if let Some(parent) = dst.parent() {
						fs::create_dir_all(parent)?;
					}
					fs::copy(&src, &dst)?;
				},
				Ok(_) => {
					return Err(Error::backend(
						"git worktree add",
						format!("cannot safely carry directory change at {}", dst.display()),
					));
				},
				Err(err)
					if matches!(
						err.kind(),
						std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
					) =>
				{
					remove_absent_worktree_path(path, relative.as_bstr(), "git worktree add")?;
				},
				Err(err) => return Err(err.into()),
			}
		}
		let source_index = self.info().git_dir.join("index");
		if source_index.is_file() {
			fs::copy(source_index, admin.join("index"))?;
		}
		Ok(())
	}

	fn worktree_add_cloned(
		&self,
		path: &Path,
		id: gix::hash::ObjectId,
		head: &str,
		kind: pi_iso::BackendKind,
		keep_changes: bool,
	) -> Result<()> {
		let repo = self.gix_fresh()?;
		for key in ["core.sparseCheckout", "core.splitIndex"] {
			if repo.config_snapshot().string(key).is_some_and(|value| {
				!matches!(value.to_str_lossy().as_ref(), "false" | "no" | "off" | "0")
			}) {
				return Err(Error::backend("git worktree add", format!("{key} is enabled")));
			}
		}
		let source_index = self.info().git_dir.join("index");
		if !source_index.is_file() {
			return Err(Error::backend("git worktree add", "source index is missing"));
		}

		pi_iso::backend(kind)
			.clone_tree(self.root(), path, &[OsStr::new(".git")])
			.map_err(|err| Error::backend("git worktree add", err))?;
		let admin = register_worktree(path, &self.info().common_dir, head)?;
		fs::copy(&source_index, admin.join("index"))?;

		let (dirty_tracked, untracked, _) = collect_worktree_changes(&repo, "git worktree add")?;
		let linked = Self::require(path)?;
		let linked_repo = linked.gix()?;
		let mut current = load_index_or_empty(&linked_repo, "git worktree add")?;
		if keep_changes {
			// The clone already mirrors the source's live tree and the copied
			// index carries its staged state. Only the stat cache is stale
			// (new inodes); refresh it for entries the source reports clean so
			// dirty files still hash on the next status.
			for (entry, entry_path) in current.entries_mut_with_paths() {
				if dirty_tracked.contains(entry_path) {
					continue;
				}
				let full = checked_worktree_path(path, entry_path, "git worktree add")?;
				let Ok(metadata) = gix::index::fs::Metadata::from_path_no_follow(&full) else {
					continue;
				};
				entry.stat = gix::index::entry::Stat::from_fs(&metadata)
					.map_err(|err| Error::backend("git worktree add", err))?;
			}
			return current
				.write(INDEX_WRITE)
				.map_err(|err| Error::backend("git worktree add", err));
		}
		let tree = commit_tree(&linked_repo, &id)?;
		let mut target = linked_repo
			.index_from_tree(&tree)
			.map_err(|err| Error::backend("git worktree add", err))?;

		let current_paths: BTreeSet<BString> = current
			.entries()
			.iter()
			.map(|entry| entry.path(&current).to_owned())
			.collect();
		let target_paths: BTreeSet<BString> = target
			.entries()
			.iter()
			.map(|entry| entry.path(&target).to_owned())
			.collect();
		let mut delete = current_paths
			.difference(&target_paths)
			.cloned()
			.collect::<BTreeSet<_>>();
		delete.extend(untracked);
		delete.extend(dirty_tracked.difference(&target_paths).cloned());

		let mut write = BTreeSet::new();
		for entry in target.entries() {
			let path = entry.path(&target);
			if current
				.entry_by_path(path)
				.is_none_or(|old| old.id != entry.id || old.mode != entry.mode)
				|| dirty_tracked.contains(path)
			{
				write.insert(path.to_owned());
			}
		}

		let mut delete = delete.into_iter().collect::<Vec<_>>();
		delete.sort_by(path_depth_descending);
		for relative in &delete {
			remove_absent_worktree_path(path, relative.as_bstr(), "git worktree add")?;
		}
		for relative in &write {
			let entry = target
				.entry_by_path(relative.as_bstr())
				.expect("write path comes from target index");
			clear_materialization_path(path, relative.as_bstr(), entry.mode, "git worktree add")?;
		}

		let mut changed = target.clone();
		for (entry, entry_path) in changed.entries_mut_with_paths() {
			if !write.contains(entry_path) {
				entry.flags.insert(gix::index::entry::Flags::SKIP_WORKTREE);
			}
		}
		let mut checkout_options = linked_repo
			.checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping)
			.map_err(|err| Error::backend("git worktree add", err))?;
		checkout_options.overwrite_existing = true;
		set_filter_context(&mut checkout_options, Some(id), FilterRef::Keep);
		let progress = gix::progress::Discard;
		let interrupt = std::sync::atomic::AtomicBool::new(false);
		let outcome = gix::worktree::state::checkout(
			&mut changed,
			path,
			linked_repo
				.objects
				.into_arc()
				.map_err(|err| Error::backend("git worktree add", err))?,
			&progress,
			&progress,
			&interrupt,
			checkout_options,
		)
		.map_err(|err| Error::backend("git worktree add", err))?;
		validate_checkout_outcome("git worktree add", &outcome)?;

		for (entry, entry_path) in target.entries_mut_with_paths() {
			if write.contains(entry_path) {
				entry.stat = changed
					.entry_by_path(entry_path)
					.expect("written path remains in checkout index")
					.stat;
			} else {
				let full = checked_worktree_path(path, entry_path, "git worktree add")?;
				let metadata = gix::index::fs::Metadata::from_path_no_follow(&full)?;
				entry.stat = gix::index::entry::Stat::from_fs(&metadata)
					.map_err(|err| Error::backend("git worktree add", err))?;
			}
		}
		target
			.write(INDEX_WRITE)
			.map_err(|err| Error::backend("git worktree add", err))
	}

	/// Remove a linked worktree, returning false when dirty and not forced.
	pub fn worktree_remove(&self, path: &Path, force: bool) -> Result<bool> {
		let Some(linked) = Self::discover(path)? else {
			return Ok(false);
		};
		if !linked.is_linked_worktree() || !force && linked.is_dirty()? {
			return Ok(false);
		}
		let canonical = |candidate: &Path| {
			fs::canonicalize(candidate).unwrap_or_else(|_| normalize_path(candidate))
		};
		let requested_root = canonical(path);
		let linked_root = canonical(linked.root());
		let owner_common = canonical(&self.info().common_dir);
		let linked_common = canonical(&linked.info().common_dir);
		let admin = canonical(&linked.info().git_dir);
		let owner_worktrees = owner_common.join("worktrees");
		if requested_root != linked_root
			|| linked_common != owner_common
			|| !admin.starts_with(&owner_worktrees)
			|| admin == owner_worktrees
		{
			return Ok(false);
		}
		fs::remove_dir_all(&linked_root)?;
		fs::remove_dir_all(admin)?;
		Ok(true)
	}

	/// Prune linked-worktree administration entries whose back-reference
	/// vanished.
	pub fn worktree_prune(&self) -> Result<()> {
		let root = self.info().common_dir.join("worktrees");
		let Ok(entries) = fs::read_dir(&root) else {
			return Ok(());
		};
		for entry in entries {
			let entry = entry?;
			let back = fs::read_to_string(entry.path().join("gitdir")).unwrap_or_default();
			if back.trim().is_empty() || !Path::new(back.trim()).exists() {
				fs::remove_dir_all(entry.path())?;
			}
		}
		Ok(())
	}
}

fn run_commit_hook(
	repository: &GitRepo,
	repo: &gix::Repository,
	name: &str,
	args: &[&OsStr],
) -> Result<()> {
	let hooks_dir = repo
		.config_snapshot()
		.string("core.hooksPath")
		.map(|value| PathBuf::from(value.to_str_lossy().into_owned()))
		.map_or_else(
			|| repository.info().git_dir.join("hooks"),
			|path| {
				if path.is_absolute() {
					path
				} else {
					repository.root().join(path)
				}
			},
		);
	let hook = hooks_dir.join(name);
	if !hook_is_executable(&hook)? {
		return Ok(());
	}
	let output = Command::new(&hook)
		.args(args)
		.current_dir(repository.root())
		.env("GIT_DIR", &repository.info().git_dir)
		.env("GIT_WORK_TREE", repository.root())
		.env("GIT_TERMINAL_PROMPT", "0")
		.stdin(Stdio::null())
		.output()
		.map_err(|err| Error::Cli {
			command:   format!("git commit ({name} hook)"),
			exit_code: 1,
			stdout:    String::new(),
			stderr:    err.to_string(),
		})?;
	if output.status.success() {
		return Ok(());
	}
	Err(Error::Cli {
		command:   format!("git commit ({name} hook)"),
		exit_code: output.status.code().unwrap_or(1),
		stdout:    String::from_utf8_lossy(&output.stdout).into_owned(),
		stderr:    String::from_utf8_lossy(&output.stderr).into_owned(),
	})
}

fn hook_is_executable(path: &Path) -> Result<bool> {
	let metadata = match fs::metadata(path) {
		Ok(metadata) => metadata,
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
		Err(err) => return Err(err.into()),
	};
	if !metadata.is_file() {
		return Ok(false);
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		Ok(metadata.permissions().mode() & 0o111 != 0)
	}
	#[cfg(not(unix))]
	{
		Ok(true)
	}
}

fn read_optional_file(path: &Path) -> Result<Option<Vec<u8>>> {
	match fs::read(path) {
		Ok(bytes) => Ok(Some(bytes)),
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
		Err(err) => Err(err.into()),
	}
}

/// Sever a copied linked worktree from its source metadata without copying
/// objects.
pub fn detach_git_dir(
	worktree_root: &Path,
	source_common_dir: &Path,
) -> Result<DetachGitDirResult> {
	let git_entry = worktree_root.join(".git");
	let meta = match fs::symlink_metadata(&git_entry) {
		Ok(meta) => meta,
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(DetachGitDirResult::NoGit),
		Err(e) => return Err(e.into()),
	};
	let source_common =
		fs::canonicalize(source_common_dir).unwrap_or_else(|_| normalize_path(source_common_dir));
	let original = GitRepo::require(worktree_root)?;
	let iso_common = fs::canonicalize(&original.info().common_dir)
		.unwrap_or_else(|_| normalize_path(&original.info().common_dir));
	if iso_common != source_common {
		return Ok(DetachGitDirResult::Independent);
	}
	let repo = original.gix()?;
	let head = read_optional_file(&original.info().head_path)?;
	let index = read_optional_file(&original.info().git_dir.join("index"))?;
	let refs = snapshot_refs(&repo)?;
	let config_values = [
		"user.name",
		"user.email",
		"core.fileMode",
		"core.splitIndex",
		"core.sparseCheckout",
		"core.sparseCheckoutCone",
	]
	.into_iter()
	.filter_map(|key| {
		repo
			.config_snapshot()
			.string(key)
			.map(|v| (key, v.to_str_lossy().into_owned()))
	})
	.collect::<Vec<_>>();
	let shared = copy_named_files(&original.info().git_dir, "sharedindex.")?;
	let sparse = read_optional_file(&original.info().git_dir.join("info/sparse-checkout"))?;
	let shallow = read_optional_file(&source_common.join("shallow"))?;
	let own_admin = if meta.is_file() {
		registered_admin(&git_entry)?
	} else {
		None
	};
	if meta.is_dir() {
		fs::remove_dir_all(&git_entry)?;
	} else {
		fs::remove_file(&git_entry)?;
	}
	if let Some(admin) = own_admin {
		fs::remove_dir_all(admin)?;
	}
	gix::init(worktree_root).map_err(|e| Error::backend("git init", e))?;
	let objects_info = git_entry.join("objects/info");
	fs::create_dir_all(&objects_info)?;
	let mut alternates = vec![source_common.join("objects")];
	if let Ok(chained) = fs::read_to_string(source_common.join("objects/info/alternates")) {
		for line in chained
			.lines()
			.map(str::trim)
			.filter(|line| !line.is_empty())
		{
			let path = Path::new(line);
			alternates.push(if path.is_absolute() {
				path.to_owned()
			} else {
				source_common.join("objects").join(path)
			});
		}
	}
	let alternate_text = alternates
		.iter()
		.map(|p| p.to_string_lossy())
		.collect::<Vec<_>>()
		.join("\n")
		+ "\n";
	fs::write(objects_info.join("alternates"), alternate_text)?;
	for (name, id) in refs {
		write_loose_ref(&git_entry, &name, id)?;
	}
	if let Some(head) = head {
		fs::write(git_entry.join("HEAD"), head)?;
	}
	for (key, value) in config_values {
		set_config_file(&git_entry.join("config"), key, &value)?;
	}
	if let Some(bytes) = shallow {
		fs::write(git_entry.join("shallow"), bytes)?;
	}
	if let Some(bytes) = sparse {
		fs::create_dir_all(git_entry.join("info"))?;
		fs::write(git_entry.join("info/sparse-checkout"), bytes)?;
	}
	for (name, bytes) in shared {
		fs::write(git_entry.join(name), bytes)?;
	}
	if let Some(bytes) = index {
		fs::write(git_entry.join("index"), bytes)?;
	} else if let Ok(detached) = GitRepo::require(worktree_root)
		&& resolve_commit(&detached.gix()?, "HEAD").is_ok()
	{
		detached.read_tree("HEAD", None)?;
	}
	Ok(DetachGitDirResult::Detached)
}

fn resolve_commit(repo: &gix::Repository, spec: &str) -> Result<gix::hash::ObjectId> {
	let id = repo
		.rev_parse_single(spec)
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
	let object = id
		.object()
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
	object
		.peel_to_commit()
		.map(|commit| commit.id)
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })
}

fn resolve_tree(repo: &gix::Repository, spec: &str) -> Result<gix::hash::ObjectId> {
	let id = repo
		.rev_parse_single(spec)
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
	let object = id
		.object()
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
	object
		.peel_to_tree()
		.map(|tree| tree.id)
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })
}

fn commit_tree(repo: &gix::Repository, id: &gix::hash::ObjectId) -> Result<gix::hash::ObjectId> {
	let commit = repo
		.find_commit(*id)
		.map_err(|e| Error::backend("git commit", e))?;
	commit
		.tree_id()
		.map(|id| id.detach())
		.map_err(|e| Error::backend("git commit", e))
}

fn head_tree(
	repo: &gix::Repository,
	operation: &'static str,
) -> Result<Option<gix::hash::ObjectId>> {
	match repo
		.head()
		.map_err(|e| Error::backend(operation, e))?
		.try_peel_to_id()
		.map_err(|e| Error::backend(operation, e))?
	{
		Some(id) => Ok(Some(
			id.object()
				.map_err(|e| Error::backend(operation, e))?
				.peel_to_commit()
				.map_err(|e| Error::backend(operation, e))?
				.tree_id()
				.map_err(|e| Error::backend(operation, e))?
				.detach(),
		)),
		None => Ok(None),
	}
}

fn index_for_tree(
	repo: &gix::Repository,
	tree: Option<&gix::hash::ObjectId>,
) -> Result<gix::index::File> {
	match tree {
		Some(tree) => repo
			.index_from_tree(tree)
			.map_err(|e| Error::backend("git index", e)),
		None => Ok(gix::index::File::from_state(
			gix::index::State::new(repo.object_hash()),
			repo.index_path(),
		)),
	}
}

fn collect_stage_paths(
	repo: &gix::Repository,
	requested: &BTreeSet<String>,
	all: bool,
) -> Result<BTreeSet<BString>> {
	let untracked = if all || requested.contains("") {
		GitRepo::ls_files_bytes_at_paths_with_repo(repo, true, true, &BTreeSet::new())?
	} else {
		GitRepo::ls_files_bytes_at_paths_with_repo(repo, true, true, requested)?
	};
	Ok(untracked.into_iter().collect())
}

fn normalize_stage_path(path: &str) -> String {
	let normalized = path.replace('\\', "/");
	let mut relative = normalized.as_str();
	while let Some(stripped) = relative.strip_prefix("./") {
		relative = stripped;
	}
	if relative == "." {
		String::new()
	} else {
		relative.trim_end_matches('/').to_owned()
	}
}

fn stage_path_matches(path: &BStr, wanted: &str) -> bool {
	let path: &[u8] = path.as_ref();
	let wanted = wanted.as_bytes();
	wanted.is_empty()
		|| path == wanted
		|| path
			.strip_prefix(wanted)
			.is_some_and(|remainder| remainder.starts_with(b"/"))
}

fn remap_composed_index_paths(
	root: &Path,
	index: &gix::index::File,
	selected: BTreeSet<String>,
) -> BTreeSet<String> {
	let mut exact = BTreeSet::new();
	let mut by_composed = BTreeMap::new();
	let mut dir_by_composed: BTreeMap<String, String> = BTreeMap::new();
	for entry in index.entries() {
		let Ok(name) = entry.path(index).to_str() else {
			continue;
		};
		exact.insert(name.to_owned());
		by_composed
			.entry(precomposed(name).into_owned())
			.or_insert_with(|| name.to_owned());
		let mut start = 0;
		while let Some(slash) = name[start..].find('/') {
			let dir = &name[..start + slash];
			if !dir.is_empty() {
				dir_by_composed
					.entry(precomposed(dir).into_owned())
					.or_insert_with(|| dir.to_owned());
			}
			start += slash + 1;
		}
	}
	selected
		.into_iter()
		.map(|path| {
			if exact.contains(&path) {
				return path;
			}
			if let Some(alias) = by_composed.get(precomposed(&path).as_ref())
				&& alias != &path
			{
				let Ok(meta) = fs::symlink_metadata(root.join(&path)) else {
					return path;
				};
				let Ok(imeta) = fs::symlink_metadata(root.join(alias)) else {
					return path;
				};
				if same_worktree_file(&meta, &imeta) {
					return alias.clone();
				}
			}
			let composed = precomposed(&path);
			if let Some(alias_dir) = dir_by_composed.get(composed.as_ref())
				&& alias_dir != &path
			{
				let Ok(meta) = fs::symlink_metadata(root.join(&path)) else {
					return path;
				};
				let Ok(imeta) = fs::symlink_metadata(root.join(alias_dir)) else {
					return path;
				};
				if same_worktree_file(&meta, &imeta) {
					return alias_dir.clone();
				}
			}
			path
		})
		.collect()
}

fn precompose_unicode_enabled(repo: &gix::Repository) -> bool {
	repo
		.config_snapshot()
		.boolean("core.precomposeUnicode")
		.unwrap_or(false)
}

fn precomposed(path: &str) -> std::borrow::Cow<'_, str> {
	gix_utils::str::precompose(std::borrow::Cow::Borrowed(path))
}

#[cfg(unix)]
fn same_worktree_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
	use std::os::unix::fs::MetadataExt;
	left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_worktree_file(_: &fs::Metadata, _: &fs::Metadata) -> bool {
	false
}

fn stage_one(
	pipeline: &mut gix::filter::Pipeline<'_>,
	filter_index: &gix::index::State,
	root: &Path,
	index: &mut gix::index::File,
	path: &BStr,
) -> Result<()> {
	checked_worktree_path(root, path, "git add")?;
	let Some((id, kind, _)) = pipeline
		.worktree_file_to_object(path, filter_index)
		.map_err(|err| Error::backend("git add", err))?
	else {
		return Err(Error::backend(
			"git add",
			format!("path is not trackable: {}", path.to_str_lossy()),
		));
	};
	index.remove_entries(|_, candidate, _| candidate == path);
	index.dangerously_push_entry(
		Default::default(),
		id,
		gix::index::entry::Flags::empty(),
		kind.into(),
		path,
	);
	Ok(())
}

fn copy_index_paths(dest: &mut gix::index::File, source: &gix::index::File, files: &[String]) {
	let requested = files.iter().cloned().collect();
	copy_index_paths_selected(dest, source, &requested);
}

fn copy_index_paths_selected(
	dest: &mut gix::index::File,
	source: &gix::index::File,
	requested: &BTreeSet<String>,
) {
	dest.remove_entries(|_, path, _| restore_selects(path, requested));
	for entry in source.entries() {
		let path = entry.path(source);
		if restore_selects(path, requested) {
			dest.dangerously_push_entry(entry.stat, entry.id, entry.flags, entry.mode, path);
		}
	}
	dest.sort_entries();
}

#[derive(Default)]
struct TreeNode {
	files: Vec<(BString, gix::index::entry::Mode, gix::hash::ObjectId)>,
	dirs:  BTreeMap<BString, Self>,
}

fn write_index_tree(
	repo: &gix::Repository,
	index: &gix::index::File,
) -> Result<gix::hash::ObjectId> {
	let mut root = TreeNode::default();
	for entry in index
		.entries()
		.iter()
		.filter(|e| e.stage() == gix::index::entry::Stage::Unconflicted)
	{
		let parts: Vec<&[u8]> = entry.path(index).split(|b| *b == b'/').collect();
		let mut node = &mut root;
		for part in &parts[..parts.len().saturating_sub(1)] {
			node = node.dirs.entry(BString::from(*part)).or_default();
		}
		if let Some(name) = parts.last() {
			node
				.files
				.push((BString::from(*name), entry.mode, entry.id));
		}
	}
	write_tree_node(repo, root)
}

fn write_tree_node(repo: &gix::Repository, node: TreeNode) -> Result<gix::hash::ObjectId> {
	let mut entries = Vec::with_capacity(node.files.len() + node.dirs.len());
	for (name, mode, oid) in node.files {
		let mode = gix::objs::tree::EntryMode::try_from(mode.bits())
			.map_err(|m| Error::backend("git write-tree", format!("invalid mode {m:o}")))?;
		entries.push(gix::objs::tree::Entry { mode, filename: name, oid });
	}
	for (name, child) in node.dirs {
		entries.push(gix::objs::tree::Entry {
			mode:     gix::objs::tree::EntryKind::Tree.into(),
			filename: name,
			oid:      write_tree_node(repo, child)?,
		});
	}
	entries.sort();
	repo
		.write_object(&gix::objs::Tree { entries })
		.map(|id| id.detach())
		.map_err(|e| Error::backend("git write-tree", e))
}

fn resolve_checkout_target(
	repo: &gix::Repository,
	rev: &str,
) -> Result<(gix::hash::ObjectId, Option<String>)> {
	let branch = if rev.starts_with("refs/heads/") {
		Some(rev.to_owned())
	} else {
		let full = format!("refs/heads/{rev}");
		repo
			.try_find_reference(&full)
			.map_err(|e| Error::backend("git checkout", e))?
			.map(|_| full)
	};
	Ok((resolve_commit(repo, branch.as_deref().unwrap_or(rev))?, branch))
}

#[derive(Clone, Copy)]
enum FilterRef<'a> {
	Keep,
	Set(Option<&'a str>),
}

fn ensure_sparse_checkout_inactive(
	repo: &gix::Repository,
	index: &gix::index::File,
	operation: &'static str,
) -> Result<()> {
	let config = repo.config_snapshot();
	let configured = config
		.boolean("core.sparseCheckout")
		.unwrap_or_else(|| config.string("core.sparseCheckout").is_some());
	let skipped = index.entries().iter().any(|entry| {
		entry
			.flags
			.contains(gix::index::entry::Flags::SKIP_WORKTREE)
	});
	if index.is_sparse() || skipped || configured {
		return Err(Error::backend(operation, "sparse checkout/index is not supported safely"));
	}
	Ok(())
}

fn checkout_tree(
	owner: &GitRepo,
	repo: &gix::Repository,
	commit: gix::hash::ObjectId,
	overwrite: bool,
	filter_ref_name: FilterRef<'_>,
) -> Result<()> {
	let tree = commit_tree(repo, &commit)?;
	let target = repo
		.index_from_tree(&tree)
		.map_err(|e| Error::backend("git checkout", e))?;
	let current = load_index_or_head(repo, "git checkout")?;
	ensure_sparse_checkout_inactive(repo, &current, "git checkout")?;
	let head_index = if overwrite {
		None
	} else {
		let head = head_tree(repo, "git checkout")?;
		Some(index_for_tree(repo, head.as_ref())?)
	};
	let comparison = head_index.as_ref().unwrap_or(&current);

	let mut changed_paths = BTreeSet::new();
	for entry in target.entries() {
		let path = entry.path(&target);
		if !overwrite
			&& comparison
				.entry_by_path(path)
				.is_some_and(|old| old.id == entry.id && old.mode == entry.mode)
		{
			continue;
		}
		changed_paths.insert(path.to_owned());
	}
	let mut affected_paths = changed_paths.clone();
	affected_paths.extend(comparison.entries().iter().filter_map(|entry| {
		let path = entry.path(comparison);
		target
			.entry_by_path(path)
			.is_none_or(|new| new.id != entry.id || new.mode != entry.mode)
			.then(|| path.to_owned())
	}));

	if !overwrite {
		let (dirty_tracked, _, staged) = collect_worktree_changes(repo, "git checkout")?;
		let mut local_changes = dirty_tracked;
		local_changes.extend(staged);
		let mut conflicts = local_changes
			.intersection(&affected_paths)
			.map(|path| path.to_str_lossy().into_owned())
			.collect::<Vec<_>>();
		conflicts.extend(
			current
				.entries()
				.iter()
				.filter(|entry| entry.stage() != gix::index::entry::Stage::Unconflicted)
				.map(|entry| entry.path(&current).to_str_lossy().into_owned()),
		);
		conflicts.sort();
		conflicts.dedup();
		if !conflicts.is_empty() {
			return Err(Error::Conflict { paths: conflicts });
		}
	}

	let mut collisions = Vec::new();
	for path in &changed_paths {
		if let Some(ancestor) =
			checkout_ancestor_collision(owner.root(), path.as_bstr(), &current, &affected_paths)?
		{
			collisions.push(ancestor);
			continue;
		}
		if let (Some(old), Some(new)) =
			(current.entry_by_path(path.as_bstr()), target.entry_by_path(path.as_bstr()))
			&& old.mode == gix::index::entry::Mode::COMMIT
			&& new.mode != gix::index::entry::Mode::COMMIT
		{
			let full = checked_worktree_path(owner.root(), path.as_bstr(), "git checkout")?;
			if fs::symlink_metadata(&full).is_ok_and(|metadata| metadata.is_dir())
				&& directory_has_entries(&full)?
			{
				collisions.push(path.to_str_lossy().into_owned());
				continue;
			}
		}
		if current.entry_by_path(path.as_bstr()).is_none() {
			let full = validated_worktree_path(owner.root(), path.as_bstr(), "git checkout")?;
			match fs::symlink_metadata(&full) {
				Ok(_) => collisions.push(path.to_str_lossy().into_owned()),
				Err(err)
					if matches!(
						err.kind(),
						std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
					) => {},
				Err(err) => return Err(err.into()),
			}
		}
	}
	collisions.sort();
	collisions.dedup();
	if !collisions.is_empty() {
		return Err(Error::Conflict { paths: collisions });
	}

	let target_paths: BTreeSet<BString> = target
		.entries()
		.iter()
		.map(|entry| entry.path(&target).to_owned())
		.collect();
	let mut removed = comparison
		.entries()
		.iter()
		.filter_map(|entry| {
			let path = entry.path(comparison);
			(!target_paths.contains(path)).then(|| path.to_owned())
		})
		.collect::<Vec<_>>();
	removed.sort_by(path_depth_descending);
	for path in &removed {
		remove_absent_worktree_path(owner.root(), path.as_bstr(), "git checkout")?;
	}

	let mut final_index = target.clone();
	if !overwrite {
		final_index.remove_entries(|_, path, _| !affected_paths.contains(path));
		for entry in current.entries() {
			let path = entry.path(&current);
			if !affected_paths.contains(path) {
				final_index.dangerously_push_entry(entry.stat, entry.id, entry.flags, entry.mode, path);
			}
		}
		final_index.sort_entries();
	}

	let mut checkout_index = target.clone();
	for (entry, path) in checkout_index.entries_mut_with_paths() {
		if !changed_paths.contains(path) {
			entry.flags.insert(gix::index::entry::Flags::SKIP_WORKTREE);
		}
	}
	for path in &changed_paths {
		let entry = target
			.entry_by_path(path.as_bstr())
			.expect("changed path comes from target index");
		clear_materialization_path(owner.root(), path.as_bstr(), entry.mode, "git checkout")?;
	}
	let mut opts = repo
		.checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping)
		.map_err(|e| Error::backend("git checkout", e))?;
	opts.overwrite_existing = true;
	set_filter_context(&mut opts, Some(commit), filter_ref_name);
	let progress = gix::progress::Discard;
	let interrupt = std::sync::atomic::AtomicBool::new(false);
	let outcome = gix::worktree::state::checkout(
		&mut checkout_index,
		owner.root(),
		repo
			.objects
			.clone()
			.into_arc()
			.map_err(|e| Error::backend("git checkout", e))?,
		&progress,
		&progress,
		&interrupt,
		opts,
	)
	.map_err(|e| Error::backend("git checkout", e))?;
	validate_checkout_outcome("git checkout", &outcome)?;
	ensure_gitlink_directories(owner.root(), &checkout_index, "git checkout")?;
	for (entry, path) in final_index.entries_mut_with_paths() {
		if changed_paths.contains(path) {
			entry.stat = checkout_index
				.entry_by_path(path)
				.expect("changed path remains in checkout index")
				.stat;
		}
	}
	final_index
		.write(INDEX_WRITE)
		.map_err(|e| Error::backend("git checkout", e))
}

fn checkout_ancestor_collision(
	root: &Path,
	path: &BStr,
	current: &gix::index::File,
	affected_paths: &BTreeSet<BString>,
) -> Result<Option<String>> {
	let bytes: &[u8] = path.as_ref();
	for (offset, byte) in bytes.iter().enumerate() {
		if *byte != b'/' {
			continue;
		}
		let ancestor = bytes[..offset].as_bstr();
		let full = validated_worktree_path(root, ancestor, "git checkout")?;
		match fs::symlink_metadata(&full) {
			Ok(metadata) if metadata.is_dir() => {
				if current.entry_by_path(ancestor).is_some() && affected_paths.contains(ancestor) {
					if directory_has_entries(&full)? {
						return Ok(Some(ancestor.to_str_lossy().into_owned()));
					}
					return Ok(None);
				}
			},
			Ok(_) => {
				if current.entry_by_path(ancestor).is_some() && affected_paths.contains(ancestor) {
					return Ok(None);
				}
				return Ok(Some(ancestor.to_str_lossy().into_owned()));
			},
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
			Err(err) if err.kind() == std::io::ErrorKind::NotADirectory => {
				return Ok(Some(ancestor.to_str_lossy().into_owned()));
			},
			Err(err) => return Err(err.into()),
		}
	}
	Ok(None)
}

fn write_head(path: &Path, symbolic: Option<&str>, id: gix::hash::ObjectId) -> Result<()> {
	fs::write(path, match symbolic {
		Some(name) => format!("ref: {name}\n"),
		None => format!("{}\n", id.to_hex()),
	})?;
	Ok(())
}

fn update_current_head(repo: &gix::Repository, path: &Path, id: gix::hash::ObjectId) -> Result<()> {
	let content = fs::read_to_string(path).unwrap_or_default();
	if let Some(name) = content.trim().strip_prefix("ref: ") {
		update_reference(
			repo,
			"git reset",
			name,
			id,
			gix::refs::transaction::PreviousValue::Any,
			"reset: moving to target",
			false,
		)?;
	} else {
		fs::write(path, format!("{}\n", id.to_hex()))?;
	}
	Ok(())
}

fn restore_index_paths(
	root: &Path,
	repo: &gix::Repository,
	source: &gix::index::File,
	tracked: &gix::index::File,
	requested: &BTreeSet<String>,
	filter_treeish: Option<gix::hash::ObjectId>,
	filter_ref_name: FilterRef<'_>,
) -> Result<()> {
	let mut checkout_index = source.clone();
	let mut source_paths = BTreeMap::new();
	let mut unmerged = Vec::new();
	for (entry, path) in checkout_index.entries_mut_with_paths() {
		if restore_selects(path, requested) {
			if entry.stage() != gix::index::entry::Stage::Unconflicted {
				unmerged.push(path.to_str_lossy().into_owned());
				continue;
			}
			entry.flags.remove(gix::index::entry::Flags::SKIP_WORKTREE);
			source_paths.insert(path.to_owned(), entry.mode);
		} else {
			entry.flags.insert(gix::index::entry::Flags::SKIP_WORKTREE);
		}
	}
	unmerged.sort();
	unmerged.dedup();
	if !unmerged.is_empty() {
		return Err(Error::Conflict { paths: unmerged });
	}

	let mut removed_paths = BTreeMap::new();
	for entry in tracked.entries() {
		let path = entry.path(tracked);
		if restore_selects(path, requested) && !source_paths.contains_key(path) {
			removed_paths.insert(path.to_owned(), entry.mode);
		}
	}
	for (path, mode) in &source_paths {
		if *mode != gix::index::entry::Mode::COMMIT
			&& tracked
				.entry_by_path(path.as_bstr())
				.is_some_and(|entry| entry.mode == gix::index::entry::Mode::COMMIT)
		{
			let full = checked_worktree_path(root, path.as_bstr(), "git restore")?;
			if fs::symlink_metadata(&full).is_ok_and(|metadata| metadata.is_dir())
				&& directory_has_entries(&full)?
			{
				return Err(Error::Conflict { paths: vec![path.to_str_lossy().into_owned()] });
			}
		}
	}
	for (path, mode) in &removed_paths {
		if *mode == gix::index::entry::Mode::COMMIT
			&& source_paths
				.keys()
				.any(|source_path| path_is_descendant(source_path.as_bstr(), path.as_bstr()))
		{
			let full = checked_worktree_path(root, path.as_bstr(), "git restore")?;
			if fs::symlink_metadata(&full).is_ok_and(|metadata| metadata.is_dir())
				&& directory_has_entries(&full)?
			{
				return Err(Error::Conflict { paths: vec![path.to_str_lossy().into_owned()] });
			}
		}
	}
	let mut removed_paths = removed_paths.into_keys().collect::<Vec<_>>();
	removed_paths.sort_by(path_depth_descending);
	for path in &removed_paths {
		remove_absent_worktree_path(root, path.as_bstr(), "git restore")?;
	}
	for (path, mode) in &source_paths {
		clear_materialization_path(root, path.as_bstr(), *mode, "git restore")?;
	}
	if source_paths.is_empty() {
		return Ok(());
	}

	let mut opts = repo
		.checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping)
		.map_err(|err| Error::backend("git restore", err))?;
	opts.overwrite_existing = true;
	opts.validate = git_platform_path_options();
	set_filter_context(&mut opts, filter_treeish, filter_ref_name);
	let progress = gix::progress::Discard;
	let interrupt = std::sync::atomic::AtomicBool::new(false);
	let outcome = gix::worktree::state::checkout(
		&mut checkout_index,
		root,
		repo
			.objects
			.clone()
			.into_arc()
			.map_err(|err| Error::backend("git restore", err))?,
		&progress,
		&progress,
		&interrupt,
		opts,
	)
	.map_err(|err| Error::backend("git restore", err))?;
	validate_checkout_outcome("git restore", &outcome)?;
	ensure_gitlink_directories(root, &checkout_index, "git restore")
}

const fn git_platform_path_options() -> gix::validate::path::component::Options {
	gix::validate::path::component::Options {
		protect_windows: cfg!(windows),
		protect_hfs:     cfg!(target_os = "macos"),
		protect_ntfs:    cfg!(windows),
	}
}

fn validate_worktree_path(root: &Path, path: &Path, operation: &'static str) -> Result<()> {
	let Some(relative) = path.strip_prefix(root).ok() else {
		return Err(Error::backend(operation, "path escapes worktree"));
	};
	if relative.components().any(|component| {
		matches!(
			component,
			std::path::Component::ParentDir
				| std::path::Component::RootDir
				| std::path::Component::Prefix(_)
		)
	}) {
		return Err(Error::backend(operation, "path escapes worktree"));
	}
	let options = git_platform_path_options();
	for component in relative.components() {
		let name = gix::path::os_str_into_bstr(component.as_os_str())
			.map_err(|err| Error::backend(operation, format!("unsafe worktree path: {err}")))?;
		gix::validate::path::component(name, None, options)
			.map_err(|err| Error::backend(operation, format!("unsafe worktree path: {err}")))?;
	}
	Ok(())
}

fn ensure_no_symlink_ancestor(root: &Path, path: &Path, operation: &'static str) -> Result<()> {
	validate_worktree_path(root, path, operation)?;
	let relative = path
		.strip_prefix(root)
		.expect("validated worktree path stays below root");
	let mut current = root.to_owned();
	for component in relative
		.components()
		.take(relative.components().count().saturating_sub(1))
	{
		current.push(component);
		match fs::symlink_metadata(&current) {
			Ok(metadata) if metadata.file_type().is_symlink() => {
				return Err(Error::backend(
					operation,
					format!("symlink ancestor in worktree path: {}", current.display()),
				));
			},
			Ok(metadata) if metadata.is_dir() => {},
			Ok(_) => break,
			Err(err)
				if matches!(
					err.kind(),
					std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
				) =>
			{
				break;
			},
			Err(err) => return Err(err.into()),
		}
	}
	Ok(())
}

fn validated_worktree_path(root: &Path, path: &BStr, operation: &'static str) -> Result<PathBuf> {
	let relative = gix::path::try_from_bstr(path).map_err(|err| {
		Error::backend(operation, format!("worktree path is not representable: {err}"))
	})?;
	let full = root.join(relative.as_ref());
	validate_worktree_path(root, &full, operation)?;
	Ok(full)
}

fn checked_worktree_path(root: &Path, path: &BStr, operation: &'static str) -> Result<PathBuf> {
	let full = validated_worktree_path(root, path, operation)?;
	ensure_no_symlink_ancestor(root, &full, operation)?;
	Ok(full)
}

fn normalize_restore_paths(files: &[String]) -> Result<BTreeSet<String>> {
	let mut requested = BTreeSet::new();
	for raw in files {
		if raw.is_empty() {
			return Err(Error::backend("git restore", "empty string is not a valid pathspec"));
		}
		requested.insert(normalize_stage_path(raw));
	}
	Ok(requested)
}

fn restore_selects(path: &BStr, requested: &BTreeSet<String>) -> bool {
	requested.is_empty()
		|| requested.contains("")
		|| requested.iter().any(|wanted| path_matches(path, wanted))
}

fn path_matches(path: &BStr, wanted: &str) -> bool {
	let path: &[u8] = path.as_ref();
	let wanted = wanted.as_bytes();
	path == wanted
		|| path
			.strip_prefix(wanted)
			.is_some_and(|remainder| remainder.starts_with(b"/"))
}

fn path_is_descendant(path: &BStr, ancestor: &BStr) -> bool {
	let path: &[u8] = path.as_ref();
	let ancestor: &[u8] = ancestor.as_ref();
	path
		.strip_prefix(ancestor)
		.is_some_and(|remainder| remainder.starts_with(b"/"))
}

fn path_is_same_or_descendant(path: &BStr, ancestor: &BStr) -> bool {
	let path: &[u8] = path.as_ref();
	let ancestor: &[u8] = ancestor.as_ref();
	let ancestor = ancestor.strip_suffix(b"/").unwrap_or(ancestor);
	path == ancestor
		|| path
			.strip_prefix(ancestor)
			.is_some_and(|remainder| remainder.starts_with(b"/"))
}

fn directory_has_entries(path: &Path) -> Result<bool> {
	Ok(fs::read_dir(path)?.next().transpose()?.is_some())
}

fn validate_restore_paths(
	source: &gix::index::File,
	tracked: &gix::index::File,
	requested: &BTreeSet<String>,
) -> Result<()> {
	if requested.is_empty() {
		return Ok(());
	}
	for wanted in requested {
		if wanted.is_empty() {
			continue;
		}
		let matched = [source, tracked].into_iter().any(|index| {
			index
				.entries()
				.iter()
				.any(|entry| path_matches(entry.path(index), wanted))
		});
		if !matched {
			return Err(Error::backend(
				"git restore",
				format!("pathspec did not match any tracked path: {wanted}"),
			));
		}
	}
	Ok(())
}

fn reject_sparse_restore(
	source: &gix::index::File,
	tracked: &gix::index::File,
	requested: &BTreeSet<String>,
) -> Result<()> {
	for index in [source, tracked] {
		for entry in index.entries() {
			let path = entry.path(index);
			let selected = restore_selects(path, requested)
				|| entry.mode == gix::index::entry::Mode::DIR
					&& (requested.iter().any(|wanted| {
						!wanted.is_empty()
							&& path_is_same_or_descendant(wanted.as_bytes().as_bstr(), path)
					}) || source.entries().iter().any(|source_entry| {
						let source_path = source_entry.path(source);
						restore_selects(source_path, requested)
							&& path_is_same_or_descendant(source_path, path)
					}));
			if entry
				.flags
				.contains(gix::index::entry::Flags::SKIP_WORKTREE)
				&& selected
			{
				return Err(Error::backend(
					"git restore",
					format!("refusing to materialize sparse-excluded path: {}", path.to_str_lossy()),
				));
			}
		}
	}
	Ok(())
}

fn index_has_gitlinks(index: &gix::index::File) -> bool {
	index
		.entries()
		.iter()
		.any(|entry| entry.mode == gix::index::entry::Mode::COMMIT)
}

fn set_filter_context(
	options: &mut gix::worktree::state::checkout::Options,
	treeish: Option<gix::hash::ObjectId>,
	ref_name: FilterRef<'_>,
) {
	let context = options.filters.driver_context_mut();
	if let Some(treeish) = treeish {
		context.treeish = Some(treeish);
	}
	if let FilterRef::Set(ref_name) = ref_name {
		context.ref_name = ref_name.map(BString::from);
	}
}

fn validate_checkout_outcome(
	operation: &'static str,
	outcome: &gix::worktree::state::checkout::Outcome,
) -> Result<()> {
	if outcome.collisions.is_empty()
		&& outcome.errors.is_empty()
		&& outcome.delayed_paths_unknown.is_empty()
		&& outcome.delayed_paths_unprocessed.is_empty()
	{
		return Ok(());
	}
	Err(Error::backend(
		operation,
		format!(
			"checkout reported {} collisions, {} errors, {} unknown delayed paths, and {} \
			 unprocessed delayed paths",
			outcome.collisions.len(),
			outcome.errors.len(),
			outcome.delayed_paths_unknown.len(),
			outcome.delayed_paths_unprocessed.len(),
		),
	))
}

fn path_depth_descending(left: &BString, right: &BString) -> std::cmp::Ordering {
	right.len().cmp(&left.len()).then_with(|| left.cmp(right))
}

fn set_config_file(path: &Path, key: &str, value: &str) -> Result<()> {
	let mut config = if path.exists() {
		gix::config::File::from_path_no_includes(path.to_owned(), gix::config::Source::Local)
			.map_err(|e| Error::backend("git config", e))?
	} else {
		gix::config::File::default()
	};
	config
		.set_raw_value(key, value)
		.map_err(|e| Error::backend("git config", e))?;
	let mut bytes = Vec::new();
	config.write_to(&mut bytes)?;
	fs::write(path, bytes)?;
	Ok(())
}

fn collect_worktree_changes(
	repo: &gix::Repository,
	operation: &'static str,
) -> Result<(BTreeSet<BString>, BTreeSet<BString>, BTreeSet<BString>)> {
	let platform =
		status_with_fresh_index(repo, operation)?.untracked_files(gix::status::UntrackedFiles::Files);
	let iter = platform
		.into_iter(std::iter::empty::<gix::bstr::BString>())
		.map_err(|err| Error::backend(operation, err))?;
	let mut dirty_tracked = BTreeSet::new();
	let mut untracked = BTreeSet::new();
	let mut staged = BTreeSet::new();
	for item in iter {
		let item = item.map_err(|err| Error::backend(operation, err))?;
		use gix::status::{Item, index_worktree};
		match item {
			Item::TreeIndex(change) => {
				use gix::diff::index::ChangeRef;
				match change {
					ChangeRef::Addition { location, .. }
					| ChangeRef::Deletion { location, .. }
					| ChangeRef::Modification { location, .. } => {
						staged.insert(location.into_owned());
					},
					ChangeRef::Rewrite { source_location, location, .. } => {
						staged.insert(source_location.into_owned());
						staged.insert(location.into_owned());
					},
				}
			},
			Item::IndexWorktree(change) => match change {
				index_worktree::Item::Modification { rela_path, status, .. }
					if !matches!(
						status,
						gix::status::plumbing::index_as_worktree::EntryStatus::NeedsUpdate(_)
					) =>
				{
					dirty_tracked.insert(rela_path);
				},
				index_worktree::Item::DirectoryContents { entry, .. }
					if entry.status == gix::dir::entry::Status::Untracked =>
				{
					untracked.insert(entry.rela_path);
				},
				index_worktree::Item::Rewrite { source, dirwalk_entry, .. } => {
					dirty_tracked.insert(dirwalk_entry.rela_path);
					match source {
						index_worktree::RewriteSource::RewriteFromIndex { source_rela_path, .. } => {
							dirty_tracked.insert(source_rela_path);
						},
						index_worktree::RewriteSource::CopyFromDirectoryEntry {
							source_dirwalk_entry,
							..
						} => {
							untracked.insert(source_dirwalk_entry.rela_path);
						},
					}
				},
				_ => {},
			},
		}
	}
	Ok((dirty_tracked, untracked, staged))
}

fn register_worktree(path: &Path, common: &Path, head: &str) -> Result<PathBuf> {
	fs::create_dir_all(path)?;
	let name = worktree_admin_name(common, path);
	let admin = common.join("worktrees").join(name);
	fs::create_dir_all(&admin)?;
	fs::write(path.join(".git"), format!("gitdir: {}\n", admin.display()))?;
	fs::write(admin.join("gitdir"), format!("{}\n", path.join(".git").display()))?;
	fs::write(admin.join("commondir"), "../..\n")?;
	fs::write(admin.join("HEAD"), format!("{head}\n"))?;
	Ok(admin)
}

fn cleanup_worktree_add(path: &Path, common: &Path) {
	let admin = registered_admin(&path.join(".git")).ok().flatten();
	let _ = fs::remove_dir_all(path);
	if let Some(admin) = admin.filter(|admin| admin.starts_with(common.join("worktrees"))) {
		let _ = fs::remove_dir_all(admin);
	}
}

fn remove_blocking_file_ancestor(root: &Path, path: &Path, operation: &'static str) -> Result<()> {
	let relative = path
		.strip_prefix(root)
		.map_err(|_| Error::backend(operation, "path escapes worktree"))?;
	let mut current = root.to_owned();
	for component in relative
		.components()
		.take(relative.components().count().saturating_sub(1))
	{
		current.push(component);
		match fs::symlink_metadata(&current) {
			Ok(metadata) if metadata.file_type().is_symlink() => {
				return Err(Error::backend(
					operation,
					format!("symlink ancestor in worktree path: {}", current.display()),
				));
			},
			Ok(metadata) if metadata.is_dir() => {},
			Ok(_) => {
				fs::remove_file(current)?;
				return Ok(());
			},
			Err(err)
				if matches!(
					err.kind(),
					std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
				) =>
			{
				return Ok(());
			},
			Err(err) => return Err(err.into()),
		}
	}
	Ok(())
}

fn remove_absent_worktree_path(root: &Path, path: &BStr, operation: &'static str) -> Result<()> {
	let full = checked_worktree_path(root, path, operation)?;
	remove_blocking_file_ancestor(root, &full, operation)?;
	let removed = match fs::symlink_metadata(&full) {
		Ok(metadata) if metadata.is_dir() => match fs::remove_dir(&full) {
			Ok(()) => true,
			Err(err) if err.kind() == std::io::ErrorKind::DirectoryNotEmpty => false,
			Err(err) => return Err(err.into()),
		},
		Ok(_) => {
			fs::remove_file(&full)?;
			true
		},
		Err(err)
			if matches!(
				err.kind(),
				std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
			) =>
		{
			false
		},
		Err(err) => return Err(err.into()),
	};
	if removed {
		prune_empty_parents(root, full.parent(), &BTreeSet::new())?;
	}
	Ok(())
}

fn clear_materialization_path(
	root: &Path,
	path: &BStr,
	mode: gix::index::entry::Mode,
	operation: &'static str,
) -> Result<()> {
	let full = checked_worktree_path(root, path, operation)?;
	remove_blocking_file_ancestor(root, &full, operation)?;
	match fs::symlink_metadata(&full) {
		Ok(metadata) if metadata.is_dir() && mode == gix::index::entry::Mode::COMMIT => {},
		Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(full)?,
		Ok(_) => fs::remove_file(full)?,
		Err(err)
			if matches!(
				err.kind(),
				std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
			) => {},
		Err(err) => return Err(err.into()),
	}
	Ok(())
}

fn ensure_gitlink_directories(
	root: &Path,
	index: &gix::index::File,
	operation: &'static str,
) -> Result<()> {
	for entry in index.entries() {
		if entry.mode != gix::index::entry::Mode::COMMIT
			|| entry
				.flags
				.contains(gix::index::entry::Flags::SKIP_WORKTREE)
		{
			continue;
		}
		let full = checked_worktree_path(root, entry.path(index), operation)?;
		match fs::symlink_metadata(&full) {
			Ok(metadata) if metadata.is_dir() => {},
			Ok(_) => {
				return Err(Error::backend(
					operation,
					format!("gitlink path is not a directory: {}", full.display()),
				));
			},
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => fs::create_dir_all(full)?,
			Err(err) => return Err(err.into()),
		}
	}
	Ok(())
}

/// Remove a file, symlink, or directory tree at `path`; missing is fine.
fn remove_existing(path: &Path) -> Result<()> {
	match fs::symlink_metadata(path) {
		Ok(meta) if meta.is_dir() => fs::remove_dir_all(path)?,
		Ok(_) => fs::remove_file(path)?,
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => {},
		Err(err) => return Err(err.into()),
	}
	Ok(())
}

/// Recreate the symlink at `src` as `dst` (a plain file holding the link
/// target on platforms without symlinks, matching git's `core.symlinks=false`).
fn copy_symlink(src: &Path, dst: &Path) -> Result<()> {
	let target = fs::read_link(src)?;
	#[cfg(unix)]
	std::os::unix::fs::symlink(&target, dst)?;
	#[cfg(not(unix))]
	fs::write(dst, target.to_string_lossy().as_bytes())?;
	Ok(())
}

/// Remove now-empty ancestors of a deleted entry, walking up from `parent`
/// and stopping at `root`, the first non-empty directory, or — when `scope`
/// is non-empty — the first directory outside every scoped pathspec.
fn prune_empty_parents(
	root: &Path,
	mut parent: Option<&Path>,
	scope: &BTreeSet<String>,
) -> Result<()> {
	while let Some(dir) = parent {
		if dir == root {
			break;
		}
		if !scope.is_empty() {
			let Ok(rel) = dir.strip_prefix(root) else {
				break;
			};
			let rel = rel.to_string_lossy().replace('\\', "/");
			let in_scope = scope.iter().any(|p| {
				*p == rel
					|| rel
						.strip_prefix(p.as_str())
						.is_some_and(|r| r.starts_with('/'))
			});
			if !in_scope {
				break;
			}
		}
		match fs::remove_dir(dir) {
			Ok(()) => parent = dir.parent(),
			Err(err)
				if matches!(
					err.kind(),
					std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
				) =>
			{
				break;
			},
			Err(err) => return Err(err.into()),
		}
	}
	Ok(())
}

fn worktree_admin_name(common: &Path, path: &Path) -> String {
	let base = path
		.file_name()
		.and_then(|s| s.to_str())
		.filter(|s| !s.is_empty())
		.unwrap_or("worktree");
	let mut name = base.to_owned();
	let mut n = 1;
	while common.join("worktrees").join(&name).exists() {
		name = format!("{base}{n}");
		n += 1;
	}
	name
}

fn branch_is_checked_out(common: &Path, full_ref: &str) -> bool {
	let expected = format!("ref: {full_ref}");
	if fs::read_to_string(common.join("HEAD")).is_ok_and(|head| head.trim() == expected) {
		return true;
	}
	let Ok(entries) = fs::read_dir(common.join("worktrees")) else {
		return false;
	};
	entries.filter_map(std::result::Result::ok).any(|entry| {
		fs::read_to_string(entry.path().join("HEAD")).is_ok_and(|head| head.trim() == expected)
	})
}

fn snapshot_refs(repo: &gix::Repository) -> Result<Vec<(String, gix::hash::ObjectId)>> {
	let platform = repo
		.references()
		.map_err(|e| Error::backend("git detach", e))?;
	let iter = platform
		.all()
		.map_err(|e| Error::backend("git detach", e))?;
	let mut out = Vec::new();
	for reference in iter {
		let mut reference = reference.map_err(|e| Error::backend("git detach", e))?;
		let name = reference.name().as_bstr().to_str_lossy().into_owned();
		if let Ok(id) = reference.peel_to_id() {
			out.push((name, id.detach()));
		}
	}
	Ok(out)
}

fn copy_named_files(dir: &Path, prefix: &str) -> Result<Vec<(String, Vec<u8>)>> {
	let mut out = Vec::new();
	let Ok(entries) = fs::read_dir(dir) else {
		return Ok(out);
	};
	for entry in entries {
		let entry = entry?;
		let name = entry.file_name().to_string_lossy().into_owned();
		if name.starts_with(prefix) {
			out.push((name, fs::read(entry.path())?));
		}
	}
	Ok(out)
}

fn registered_admin(git_entry: &Path) -> Result<Option<PathBuf>> {
	let text = fs::read_to_string(git_entry)?;
	let Some(raw) = text.trim().strip_prefix("gitdir:") else {
		return Ok(None);
	};
	let admin = normalize_path(
		&git_entry
			.parent()
			.unwrap_or_else(|| Path::new("."))
			.join(raw.trim()),
	);
	let back = fs::read_to_string(admin.join("gitdir")).unwrap_or_default();
	let real_back =
		fs::canonicalize(back.trim()).unwrap_or_else(|_| normalize_path(Path::new(back.trim())));
	let real_entry = fs::canonicalize(git_entry).unwrap_or_else(|_| normalize_path(git_entry));
	Ok((real_back == real_entry).then_some(admin))
}

fn write_loose_ref(git_dir: &Path, name: &str, id: gix::hash::ObjectId) -> Result<()> {
	let path = git_dir.join(name);
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)?;
	}
	fs::write(path, format!("{}\n", id.to_hex()))?;
	Ok(())
}
#[cfg(test)]
mod tests {
	use std::process::Command;

	use tempfile::TempDir;

	use super::*;
	use crate::types::CommitAuthor;

	fn git(dir: &Path, args: &[&str]) -> String {
		let output = Command::new("git")
			.arg("-C")
			.arg(dir)
			.args(args)
			.output()
			.unwrap();
		assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
		String::from_utf8(output.stdout)
			.unwrap()
			.trim_end()
			.to_owned()
	}

	#[cfg(target_os = "linux")]
	fn git_bytes(dir: &Path, args: &[&str]) -> Vec<u8> {
		let output = Command::new("git")
			.arg("-C")
			.arg(dir)
			.args(args)
			.output()
			.unwrap();
		assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
		output.stdout
	}

	fn fixture() -> (TempDir, GitRepo) {
		let temp = tempfile::tempdir().unwrap();
		git(temp.path(), &["init", "-q", "-b", "main"]);
		git(temp.path(), &["config", "user.name", "Test"]);
		git(temp.path(), &["config", "user.email", "test@example.com"]);
		fs::write(temp.path().join("a"), "one\n").unwrap();
		fs::write(temp.path().join("b"), "two\n").unwrap();
		git(temp.path(), &["add", "."]);
		git(temp.path(), &["commit", "-qm", "base"]);
		let repo = GitRepo::require(temp.path()).unwrap();
		(temp, repo)
	}

	#[test]
	fn mutate_stage_commit_amend_and_empty() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join("a"), "changed\n").unwrap();
		fs::write(temp.path().join("new"), "new\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "M  a\n?? new");
		let first = repo
			.commit_create("change", &CommitOptions {
				author: Some(CommitAuthor {
					name:  "Other".into(),
					email: "other@example.com".into(),
					date:  Some("2020-01-02T03:04:05Z".into()),
				}),
				..Default::default()
			})
			.unwrap();
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), first);
		assert_eq!(
			git(temp.path(), &["show", "-s", "--format=%an <%ae>", "HEAD"]),
			"Other <other@example.com>"
		);
		assert!(
			repo
				.commit_create("empty", &CommitOptions::default())
				.is_err()
		);
		fs::write(temp.path().join("a"), "amended\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		let amended = repo
			.commit_create("amended", &CommitOptions { amend: true, ..Default::default() })
			.unwrap();
		assert_ne!(first, amended);
		assert_eq!(git(temp.path(), &["rev-list", "--count", "HEAD"]), "2");
		repo.stage_files(&[]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "A  new");
		repo.unstage(&[]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "?? new");
	}

	#[test]
	fn unstage_refreshes_head_after_out_of_band_commit() {
		let (temp, repo) = fixture();
		drop(repo.gix().unwrap());
		fs::write(temp.path().join("a"), "committed later\n").unwrap();
		git(temp.path(), &["add", "a"]);
		git(temp.path(), &["commit", "-qm", "advance head"]);

		fs::write(temp.path().join("a"), "staged later\n").unwrap();
		git(temp.path(), &["add", "a"]);
		repo.unstage(&["a".into()]).unwrap();

		assert_eq!(git(temp.path(), &["show", ":a"]), "committed later");
		assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "staged later\n");
	}

	#[test]
	fn stage_all_skips_nested_gitignore_like_git_add() {
		let (temp, repo) = fixture();
		drop(repo.gix().unwrap());
		let excludes = temp.path().join(".git/global-excludes");
		fs::write(&excludes, "global-secret\n").unwrap();
		git(temp.path(), &["config", "core.excludesFile", excludes.to_str().unwrap()]);
		fs::write(temp.path().join("global-secret"), "ignored\n").unwrap();
		fs::create_dir_all(temp.path().join("tests/e2e/screenshots")).unwrap();
		fs::write(temp.path().join("tests/e2e/.gitignore"), "screenshots/\ntest-results/\n").unwrap();
		fs::write(temp.path().join("tests/e2e/screenshots/homepage.png"), "png").unwrap();
		fs::write(temp.path().join("tests/e2e/visible.txt"), "ok\n").unwrap();
		repo.stage_files(&[]).unwrap();
		let status = git(temp.path(), &["status", "--porcelain"]);
		assert!(!status.contains("screenshots"), "nested-ignored screenshot was staged:\n{status}");
		assert!(
			!status.contains("global-secret"),
			"out-of-band global exclude was ignored: fresh collector staged {status}"
		);
		assert!(
			status.contains("tests/e2e/.gitignore"),
			"gitignore itself should be staged:\n{status}"
		);
		assert!(
			status.contains("tests/e2e/visible.txt"),
			"unignored sibling should be staged:\n{status}"
		);
	}

	#[test]
	fn stage_explicit_ignored_file_is_skipped() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join(".gitignore"), "secret\n").unwrap();
		fs::write(temp.path().join("secret"), "x\n").unwrap();
		fs::write(temp.path().join("visible"), "y\n").unwrap();
		repo
			.stage_files(&["secret".into(), "visible".into()])
			.unwrap();
		let status = git(temp.path(), &["status", "--porcelain"]);
		assert!(!status.contains("secret"), "explicit ignored path was staged:\n{status}");
		assert!(status.contains("visible"), "explicit unignored path should be staged:\n{status}");
	}

	#[test]
	fn stage_dot_pathspec_matches_repository_root() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join("a"), "changed\n").unwrap();
		fs::write(temp.path().join(".gitignore"), "secret\n").unwrap();
		fs::write(temp.path().join("visible"), "visible\n").unwrap();
		fs::write(temp.path().join("secret"), "secret\n").unwrap();

		repo.stage_files(&[".".into()]).unwrap();
		let status = git(temp.path(), &["status", "--porcelain"]);
		assert!(status.contains("M  a"), "tracked root file should be staged:\n{status}");
		assert!(status.contains("A  visible"), "untracked root file should be staged:\n{status}");
		assert!(
			!git(temp.path(), &["ls-files"])
				.lines()
				.any(|path| path == "secret"),
			"ignored root file must stay untracked"
		);
	}

	#[test]
	fn stage_dot_prefixed_directory_pathspec_is_scoped() {
		let (temp, repo) = fixture();
		fs::create_dir(temp.path().join("dir")).unwrap();
		fs::write(temp.path().join("dir/tracked"), "base\n").unwrap();
		git(temp.path(), &["add", "--", "dir/tracked"]);
		git(temp.path(), &["commit", "-qm", "directory"]);
		fs::write(temp.path().join("dir/tracked"), "changed\n").unwrap();
		fs::write(temp.path().join("dir/new"), "new\n").unwrap();
		fs::write(temp.path().join("outside"), "outside\n").unwrap();

		repo.stage_files(&["./dir".into()]).unwrap();
		let status = git(temp.path(), &["status", "--porcelain"]);
		assert!(status.contains("M  dir/tracked"), "tracked child should be staged:\n{status}");
		assert!(status.contains("A  dir/new"), "untracked child should be staged:\n{status}");
		assert!(status.contains("?? outside"), "unrequested path should stay untracked:\n{status}");
	}

	#[test]
	fn stage_explicit_metachar_directory_is_literal() {
		let (temp, repo) = fixture();
		fs::create_dir(temp.path().join("[x]")).unwrap();
		fs::create_dir(temp.path().join("x")).unwrap();
		fs::write(temp.path().join("[x]/selected"), "selected\n").unwrap();
		fs::write(temp.path().join("x/unselected"), "unselected\n").unwrap();

		repo.stage_files(&["[x]".into()]).unwrap();
		let status = git(temp.path(), &["status", "--porcelain"]);
		assert!(
			status.contains("A  [x]/selected"),
			"literal metacharacter directory should be staged:\n{status}"
		);
		assert!(
			status.contains("?? x/"),
			"pattern lookalike directory should stay untracked:\n{status}"
		);
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn stage_all_does_not_add_nfd_duplicate_of_nfc_index_path() {
		let (temp, repo) = fixture();
		let nfc = "caf\u{e9}.txt";
		let nfd = "cafe\u{301}.txt";
		fs::write(temp.path().join(nfc), "hello\n").unwrap();
		git(temp.path(), &["add", "--", nfc]);
		git(temp.path(), &["commit", "-qm", "accent"]);
		let before = git(temp.path(), &["ls-files", "-z"]);
		assert!(
			before.split('\0').filter(|p| p.contains("caf")).count() == 1,
			"setup should track one NFC path, got {before:?}"
		);
		assert!(!before.contains('\u{301}'), "git add should store NFC, got {before:?}");

		repo.stage_files(&[]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");
		let after = git(temp.path(), &["ls-files", "-z"]);
		let cafe: Vec<_> = after.split('\0').filter(|p| p.contains("caf")).collect();
		assert_eq!(cafe, [nfc], "native add created a unicode duplicate: {after:?}");

		repo.stage_files(&[nfd.to_owned()]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");
		let after_explicit = git(temp.path(), &["ls-files", "-z"]);
		let cafe: Vec<_> = after_explicit
			.split('\0')
			.filter(|p| p.contains("caf"))
			.collect();
		assert_eq!(cafe, [nfc], "explicit NFD add created a unicode duplicate: {after_explicit:?}");
	}

	#[cfg(unix)]
	#[test]
	fn stage_explicit_hardlink_keeps_unrelated_name() {
		let (temp, repo) = fixture();
		fs::hard_link(temp.path().join("a"), temp.path().join("link")).unwrap();
		repo.stage_files(&["link".into()]).unwrap();
		let files = git(temp.path(), &["ls-files"]);
		assert!(files.contains('a'), "tracked original must remain:\n{files}");
		assert!(
			files.contains("link"),
			"unrelated hardlink name must be staged as its own path:\n{files}"
		);
	}

	#[test]
	fn stage_keeps_distinct_nfc_and_nfd_when_precompose_is_off() {
		let temp = tempfile::tempdir().unwrap();
		git(temp.path(), &["init", "-q", "-b", "main"]);
		git(temp.path(), &["config", "user.name", "Test"]);
		git(temp.path(), &["config", "user.email", "test@example.com"]);
		git(temp.path(), &["config", "core.precomposeunicode", "false"]);
		fs::write(temp.path().join("tracked"), "base\n").unwrap();
		git(temp.path(), &["add", "."]);
		git(temp.path(), &["commit", "-qm", "base"]);
		let repo = GitRepo::require(temp.path()).unwrap();

		let nfc = "caf\u{e9}.txt";
		let nfd = "cafe\u{301}.txt";
		fs::write(temp.path().join(nfc), "nfc\n").unwrap();
		fs::write(temp.path().join(nfd), "nfd\n").unwrap();
		let nfc_body = fs::read_to_string(temp.path().join(nfc)).unwrap();
		let nfd_body = fs::read_to_string(temp.path().join(nfd)).unwrap();
		if nfc_body == nfd_body {
			return;
		}

		git(temp.path(), &["add", "--", nfc]);
		git(temp.path(), &["commit", "-qm", "nfc"]);
		repo.stage_files(&[nfd.to_owned()]).unwrap();
		let files = git(temp.path(), &["ls-files", "-z"]);
		let cafe: Vec<_> = files.split('\0').filter(|p| p.contains("caf")).collect();
		assert_eq!(cafe.len(), 2, "NFC and NFD must stay distinct when precompose is off: {files:?}");
		assert!(cafe.contains(&nfc), "{cafe:?}");
		assert!(cafe.contains(&nfd), "{cafe:?}");
	}

	#[cfg(unix)]
	fn write_hook(path: &Path, body: &str, executable: bool) {
		use std::os::unix::fs::PermissionsExt;
		fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
		let mode = if executable { 0o755 } else { 0o644 };
		fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
	}

	#[test]
	fn stage_commit_survives_unadvanced_index_mtime() {
		// Regression: a commit right after staging on the same cached handle used
		// to read a stale in-memory index snapshot when the on-disk index mtime
		// did not advance past the snapshot's (sub-second writes / coarse mtime
		// filesystems), failing with "nothing to commit, working tree clean".
		let (temp, repo) = fixture();
		// Pin the mtime so the snapshot captured while staging and the index the
		// write leaves behind collide on the exact same tick.
		crate::git::pin_index_mtime(&repo);

		fs::write(temp.path().join("a"), "changed\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		// Staging bumped the mtime; forcing it back reproduces the same-tick
		// collision that made gix serve the pre-stage index.
		crate::git::pin_index_mtime(&repo);

		let sha = repo
			.commit_create("change", &CommitOptions::default())
			.unwrap();
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), sha);
		// The commit must carry the staged content, not the stale base index.
		assert_eq!(git(temp.path(), &["show", "HEAD:a"]), "changed");
	}

	#[cfg(unix)]
	#[test]
	fn commit_hooks_match_git_commit_behavior() {
		let (temp, repo) = fixture();
		let hooks = temp.path().join(".git/hooks");
		let pre_commit = hooks.join("pre-commit");
		write_hook(&pre_commit, "echo 'policy says no' >&2\nexit 1", true);
		fs::write(temp.path().join("a"), "blocked\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		let before = git(temp.path(), &["rev-parse", "HEAD"]);
		let error = repo
			.commit_create("blocked", &CommitOptions::default())
			.unwrap_err();
		assert!(matches!(
			&error,
			Error::Cli { stderr, .. } if stderr.contains("policy says no")
		));
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), before);

		fs::remove_file(&pre_commit).unwrap();
		write_hook(
			&hooks.join("commit-msg"),
			"printf 'rewritten subject\\n\\nrewritten body\\n' > \"$1\"",
			true,
		);
		repo
			.commit_create("original", &CommitOptions::default())
			.unwrap();
		assert_eq!(
			git(temp.path(), &["log", "-1", "--pretty=%B"]),
			"rewritten subject\n\nrewritten body"
		);

		fs::write(temp.path().join("b"), "changed again\n").unwrap();
		repo.stage_files(&["b".into()]).unwrap();
		fs::remove_file(hooks.join("commit-msg")).unwrap();
		repo
			.commit_create("missing hook is skipped", &CommitOptions::default())
			.unwrap();

		fs::write(temp.path().join("b"), "one more\n").unwrap();
		repo.stage_files(&["b".into()]).unwrap();
		write_hook(&pre_commit, "echo should-not-run >&2\nexit 1", false);
		repo
			.commit_create("non-executable hook is skipped", &CommitOptions::default())
			.unwrap();
		fs::remove_file(&pre_commit).unwrap();
		repo
			.commit_create("subject\n\nbody\n\n", &CommitOptions {
				allow_empty: true,
				..CommitOptions::default()
			})
			.unwrap();
		assert_eq!(repo.commit_details("HEAD").unwrap().message, "subject\n\nbody\n");
	}

	#[test]
	fn mutate_checkout_branches_and_resets() {
		let (temp, repo) = fixture();
		repo.create_branch("other", "HEAD", false).unwrap();
		fs::write(temp.path().join("a"), "main\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		let main = repo
			.commit_create("main", &CommitOptions::default())
			.unwrap();
		fs::write(temp.path().join("a"), "dirty\n").unwrap();
		assert!(matches!(repo.checkout("other"), Err(Error::Conflict { .. })));
		fs::write(temp.path().join("a"), "main\n").unwrap();
		repo.checkout("other").unwrap();
		assert_eq!(git(temp.path(), &["symbolic-ref", "--short", "HEAD"]), "other");
		repo.checkout("main").unwrap();
		repo.reset(ResetMode::Soft, Some("HEAD^")).unwrap();
		assert!(git(temp.path(), &["status", "--porcelain"]).starts_with("M  a"));
		repo.reset(ResetMode::Hard, Some(&main)).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");
		fs::write(temp.path().join("a"), "mixed\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		repo.reset(ResetMode::Mixed, Some("HEAD^")).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), " M a");
		repo.reset(ResetMode::Hard, Some(&main)).unwrap();
		assert!(repo.delete_branch("other", true).unwrap());
		assert!(!repo.delete_branch("missing", true).unwrap());
	}

	#[test]
	fn mutate_clean_and_alternate_index() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join(".gitignore"), "ignored\n").unwrap();
		repo.stage_files(&[".gitignore".into()]).unwrap();
		repo
			.commit_create("ignore", &CommitOptions::default())
			.unwrap();
		fs::write(temp.path().join("ignored"), "x").unwrap();
		fs::write(temp.path().join("untracked"), "x").unwrap();
		repo.clean(&CleanOptions::default()).unwrap();
		assert!(temp.path().join("ignored").exists());
		assert!(!temp.path().join("untracked").exists());
		repo
			.clean(&CleanOptions { ignored_only: true, ..Default::default() })
			.unwrap();
		assert!(!temp.path().join("ignored").exists());
		fs::write(temp.path().join("ignored"), "x").unwrap();
		fs::write(temp.path().join("untracked"), "x").unwrap();
		repo
			.clean(&CleanOptions { include_ignored: true, ..Default::default() })
			.unwrap();
		assert!(!temp.path().join("ignored").exists());
		assert!(!temp.path().join("untracked").exists());
		let alternate = temp.path().join("alternate-index");
		repo.read_tree("HEAD", Some(&alternate)).unwrap();
		assert_eq!(
			repo.write_tree(Some(&alternate)).unwrap(),
			git(temp.path(), &["rev-parse", "HEAD^{tree}"])
		);
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn stage_all_preserves_and_adds_non_utf8_paths() {
		use std::os::unix::ffi::OsStrExt;

		let (temp, repo) = fixture();
		let tracked_name = b"tracked-\xff.txt";
		let tracked = temp.path().join(OsStr::from_bytes(tracked_name));
		fs::write(&tracked, "original\n").unwrap();
		git(temp.path(), &["add", "-A"]);
		git(temp.path(), &["commit", "-qm", "track non-utf8 path"]);

		fs::write(&tracked, "changed\n").unwrap();
		let untracked_name = b"untracked-\xfe.txt";
		let untracked = temp.path().join(OsStr::from_bytes(untracked_name));
		fs::write(&untracked, "new\n").unwrap();

		repo.stage_files(&[]).unwrap();

		let files = git_bytes(temp.path(), &["ls-files", "-z"]);
		let files = files.split(|byte| *byte == 0).collect::<Vec<_>>();
		assert!(files.contains(&tracked_name.as_slice()));
		assert!(files.contains(&untracked_name.as_slice()));
		let staged = git_bytes(temp.path(), &["diff", "--cached", "--name-only", "-z"]);
		let staged = staged.split(|byte| *byte == 0).collect::<Vec<_>>();
		assert!(staged.contains(&tracked_name.as_slice()));
		assert!(staged.contains(&untracked_name.as_slice()));
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn clean_preserves_tracked_path_that_lossily_matches_untracked_path() {
		use std::os::unix::ffi::OsStrExt;

		let (temp, repo) = fixture();
		let tracked = temp.path().join("lossy-\u{fffd}.txt");
		fs::write(&tracked, "tracked\n").unwrap();
		repo.stage_files(&["lossy-\u{fffd}.txt".into()]).unwrap();
		repo
			.commit_create("tracked lossy path", &CommitOptions::default())
			.unwrap();

		let untracked = temp.path().join(OsStr::from_bytes(b"lossy-\xff.txt"));
		fs::write(&untracked, "untracked\n").unwrap();
		repo.clean(&CleanOptions::default()).unwrap();

		assert_eq!(fs::read_to_string(tracked).unwrap(), "tracked\n");
		assert!(!untracked.exists());
	}

	#[test]
	fn clean_respects_nested_ignores_and_preserves_submodules() {
		let (temp, repo) = fixture();
		let outside = tempfile::tempdir().unwrap();
		// 1. Nested gitignore
		let nested = temp.path().join("nested");
		fs::create_dir_all(&nested).unwrap();
		fs::write(nested.join(".gitignore"), "secret.env\n").unwrap();
		repo.stage_files(&["nested/.gitignore".into()]).unwrap();
		repo
			.commit_create("add nested gitignore", &CommitOptions::default())
			.unwrap();
		fs::write(nested.join("secret.env"), "secret\n").unwrap();
		fs::write(nested.join("untracked.txt"), "delete\n").unwrap();

		// 2. Checked-out submodule
		let sub = temp.path().join("sub-repo");
		fs::create_dir_all(&sub).unwrap();
		git(&sub, &["init", "-q", "-b", "main"]);
		git(&sub, &["config", "user.email", "test@example.com"]);
		git(&sub, &["config", "user.name", "test"]);
		fs::write(sub.join("sub-file.txt"), "committed-in-sub\n").unwrap();
		git(&sub, &["add", "."]);
		git(&sub, &["commit", "-qm", "sub init"]);

		git(temp.path(), &[
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"-q",
			"add",
			sub.to_str().unwrap(),
			"my-submodule",
		]);
		git(temp.path(), &["commit", "-qm", "add submodule"]);

		let checked_out_sub = temp.path().join("my-submodule");
		fs::write(checked_out_sub.join("dirty-untracked.txt"), "sub untracked\n").unwrap();
		fs::write(checked_out_sub.join("sub-file.txt"), "sub modified\n").unwrap();

		// 3. Parent untracked file
		fs::write(temp.path().join("parent-untracked.txt"), "delete\n").unwrap();

		// 4. Global excludesfile (core.excludesFile), configured *after* `repo`'s
		//    cached gix handle was opened by the staging calls above. The clean below
		//    must observe it or `global.env` is deleted.
		let global_exclude = outside.path().join("global-excludes");
		fs::write(&global_exclude, "global.env\n").unwrap();
		git(temp.path(), &["config", "core.excludesFile", global_exclude.to_str().unwrap()]);
		fs::write(temp.path().join("global.env"), "global-secret\n").unwrap();

		// 4b. Repository-local `.git/info/exclude`
		let info_dir = repo.info().git_dir.join("info");
		fs::create_dir_all(&info_dir).unwrap();
		fs::write(info_dir.join("exclude"), "info-excluded.env\n").unwrap();
		fs::write(temp.path().join("info-excluded.env"), "info-secret\n").unwrap();

		// 5. Untracked nested repository
		let untracked_repo = temp.path().join("untracked-nested-repo");
		fs::create_dir_all(&untracked_repo).unwrap();
		git(&untracked_repo, &["init", "-q", "-b", "main"]);
		fs::write(untracked_repo.join("nested.txt"), "nested content\n").unwrap();

		// 6. Symlink to directory (must unlink the symlink, not delete the target
		//    directory)
		#[cfg(unix)]
		let target_dir = outside.path().join("target-dir");
		#[cfg(unix)]
		{
			fs::create_dir_all(&target_dir).unwrap();
			fs::write(target_dir.join("important.txt"), "keep this\n").unwrap();
			std::os::unix::fs::symlink(&target_dir, temp.path().join("symlink-to-dir")).unwrap();
		}

		// 7. Untracked directory with file inside: empty directory gets pruned
		let to_prune = temp.path().join("untracked-dir/subdir");
		fs::create_dir_all(&to_prune).unwrap();
		fs::write(to_prune.join("leaf.txt"), "leaf\n").unwrap();

		// 8. Untracked directory initially empty: pruned (-d contract)
		let initially_empty = temp.path().join("initially-empty-dir");
		fs::create_dir_all(&initially_empty).unwrap();

		// 9. Ignored empty directory: MUST SURVIVE
		let ignored_empty = temp.path().join("ignored-empty-dir");
		fs::create_dir_all(&ignored_empty).unwrap();
		let sub_gitignore = temp.path().join(".gitignore");
		let mut current_gitignore = fs::read_to_string(&sub_gitignore).unwrap_or_default();
		current_gitignore.push_str("ignored-empty-dir/\n");
		fs::write(&sub_gitignore, current_gitignore).unwrap();

		repo
			.clean(&CleanOptions { paths: vec!["nested".into()], ..Default::default() })
			.unwrap();
		assert!(
			!nested.join("untracked.txt").exists(),
			"pathspec-scoped clean removes matches under the path"
		);
		assert!(
			nested.join("secret.env").exists(),
			"pathspec-scoped clean still honors nested ignores"
		);
		assert!(
			temp.path().join("parent-untracked.txt").exists(),
			"pathspec-scoped clean leaves paths outside the pathspec"
		);
		assert!(
			initially_empty.exists(),
			"pathspec-scoped clean leaves directories outside the pathspec"
		);
		// 10. Pathspec scoping: cleaning with a pathspec prunes empty dirs inside the
		//     pathspec but preserves the parent
		let pathspec_dir = temp.path().join("pathspec-parent/child/grandchild");
		fs::create_dir_all(&pathspec_dir).unwrap();
		fs::write(pathspec_dir.join("leaf.txt"), "leaf\n").unwrap();
		repo
			.clean(&CleanOptions { paths: vec!["pathspec-parent/child".into()], ..Default::default() })
			.unwrap();
		assert!(
			!temp.path().join("pathspec-parent/child").exists(),
			"empty dir inside pathspec must be pruned"
		);
		assert!(
			temp.path().join("pathspec-parent").exists(),
			"parent directory outside pathspec must not be pruned"
		);

		repo.clean(&CleanOptions::default()).unwrap();

		// Untracked files deleted and parent directories pruned
		assert!(!temp.path().join("parent-untracked.txt").exists());
		assert!(!nested.join("untracked.txt").exists());
		assert!(!temp.path().join("untracked-dir").exists());
		assert!(!temp.path().join("pathspec-parent").exists());
		assert!(!initially_empty.exists(), "empty untracked directory must be pruned by -d");

		// Ignored empty directory MUST SURVIVE
		assert!(ignored_empty.exists(), "ignored empty directory must survive clean");

		// Nested ignored file MUST SURVIVE
		assert!(nested.join("secret.env").exists());
		assert_eq!(fs::read_to_string(nested.join("secret.env")).unwrap(), "secret\n");

		// Global excluded file MUST SURVIVE (config set after the handle was cached)
		assert!(temp.path().join("global.env").exists());
		assert_eq!(fs::read_to_string(temp.path().join("global.env")).unwrap(), "global-secret\n");

		// `.git/info/exclude` file MUST SURVIVE
		assert_eq!(
			fs::read_to_string(temp.path().join("info-excluded.env")).unwrap(),
			"info-secret\n"
		);

		// Submodule files and .git MUST SURVIVE
		assert!(checked_out_sub.join(".git").exists());
		assert!(checked_out_sub.join("sub-file.txt").exists());
		assert_eq!(
			fs::read_to_string(checked_out_sub.join("sub-file.txt")).unwrap(),
			"sub modified\n"
		);
		assert!(checked_out_sub.join("dirty-untracked.txt").exists());

		// Untracked nested repo MUST SURVIVE
		assert!(untracked_repo.join(".git").exists());
		assert!(untracked_repo.join("nested.txt").exists());
		// Symlink to directory: symlink is removed, target directory content survives
		#[cfg(unix)]
		{
			assert!(!temp.path().join("symlink-to-dir").exists());
			assert!(target_dir.join("important.txt").exists());
		}
	}

	#[test]
	fn clean_rejects_empty_pathspec_and_treats_dot_as_everything() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join("untracked.txt"), "x").unwrap();

		let err = repo
			.clean(&CleanOptions { paths: vec![String::new()], ..Default::default() })
			.unwrap_err();
		assert!(
			err.to_string()
				.contains("empty string is not a valid pathspec"),
			"{err}"
		);
		assert!(
			temp.path().join("untracked.txt").exists(),
			"an empty pathspec must not widen to the whole worktree"
		);

		repo
			.clean(&CleanOptions { paths: vec!["./".into()], ..Default::default() })
			.unwrap();
		assert!(!temp.path().join("untracked.txt").exists(), "`.` selects everything like git");
	}

	#[cfg(unix)]
	#[test]
	fn detach_git_dir_does_not_mutate_when_index_snapshot_fails() {
		use std::os::unix::fs::PermissionsExt;

		let (temp, repo) = fixture();
		let linked = temp.path().join("../linked-unreadable-index");
		let _ = fs::remove_dir_all(&linked);
		repo
			.worktree_add(&linked, "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
			})
			.unwrap();
		let common = fs::canonicalize(repo.info().common_dir.clone()).unwrap();
		let linked_repo = GitRepo::require(&linked).unwrap();
		let index_path = linked_repo.info().git_dir.join("index");
		let original_mode = fs::metadata(&index_path).unwrap().permissions().mode();
		let pointer_before = fs::read(linked.join(".git")).unwrap();
		fs::set_permissions(&index_path, fs::Permissions::from_mode(0o000)).unwrap();

		let result = detach_git_dir(&linked, &common);
		fs::set_permissions(&index_path, fs::Permissions::from_mode(original_mode)).unwrap();
		assert!(matches!(
			&result,
			Err(Error::Io(err)) if err.kind() == std::io::ErrorKind::PermissionDenied
		));
		assert_eq!(fs::read(linked.join(".git")).unwrap(), pointer_before);
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), git(&linked, &["rev-parse", "HEAD"]));
		let _ = fs::remove_dir_all(linked);
	}

	#[test]
	fn clone_first_worktree_reconciles_source_state_to_target_tree() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join(".gitignore"), "build/\n").unwrap();
		git(temp.path(), &["add", ".gitignore"]);
		git(temp.path(), &["commit", "-qm", "ignore build"]);
		git(temp.path(), &["checkout", "-qb", "target"]);
		fs::write(temp.path().join("a"), "target\n").unwrap();
		fs::remove_file(temp.path().join("b")).unwrap();
		fs::write(temp.path().join("c"), "added\n").unwrap();
		git(temp.path(), &["add", "-A"]);
		git(temp.path(), &["commit", "-qm", "target tree"]);
		git(temp.path(), &["checkout", "-q", "main"]);
		fs::write(temp.path().join("a"), "dirty\n").unwrap();
		fs::write(temp.path().join("untracked"), "untracked\n").unwrap();
		fs::create_dir_all(temp.path().join("build")).unwrap();
		fs::write(temp.path().join("build/out.txt"), "ignored\n").unwrap();

		let linked = temp.path().join("../linked-clone-first");
		let _ = fs::remove_dir_all(&linked);
		let result = repo
			.worktree_add(&linked, "target", WorktreeAddOptions {
				detach:       false,
				clone:        WorktreeClone::Auto,
				keep_changes: false,
			})
			.unwrap();

		assert_eq!(fs::read_to_string(linked.join("a")).unwrap(), "target\n");
		assert_eq!(fs::read_to_string(linked.join("c")).unwrap(), "added\n");
		assert!(!linked.join("b").exists());
		assert!(!linked.join("untracked").exists());
		assert!(
			fs::read_to_string(linked.join(".git"))
				.unwrap()
				.starts_with("gitdir: ")
		);
		let linked_repo = GitRepo::require(&linked).unwrap();
		assert_eq!(
			fs::read_to_string(&linked_repo.info().head_path).unwrap(),
			"ref: refs/heads/target\n"
		);
		let gix = linked_repo.gix().unwrap();
		let mut status = status_with_fresh_index(&gix, "git status")
			.unwrap()
			.untracked_files(gix::status::UntrackedFiles::Files)
			.into_iter(std::iter::empty::<BString>())
			.unwrap();
		assert!(status.next().is_none());

		if result.cloned_with.is_some() {
			assert_eq!(fs::read_to_string(linked.join("build/out.txt")).unwrap(), "ignored\n");
		} else {
			assert!(!linked.join("build/out.txt").exists());
			assert!(
				result.clone_error.is_some() || pi_iso::clone_candidates(None).is_empty(),
				"a failed clone attempt must surface its reason"
			);
		}
		let _ = repo.worktree_remove(&linked, true);
	}

	#[test]
	fn worktree_add_keep_changes_carries_dirty_state_on_both_paths() {
		for clone in [WorktreeClone::Auto, WorktreeClone::Off] {
			let (temp, repo) = fixture();
			fs::write(temp.path().join(".gitignore"), "build/\n").unwrap();
			git(temp.path(), &["add", ".gitignore"]);
			git(temp.path(), &["commit", "-qm", "ignore build"]);
			fs::write(temp.path().join("a"), "staged\n").unwrap();
			git(temp.path(), &["add", "a"]);
			fs::write(temp.path().join("a"), "staged then edited\n").unwrap();
			fs::remove_file(temp.path().join("b")).unwrap();
			fs::create_dir_all(temp.path().join("new/dir")).unwrap();
			fs::write(temp.path().join("new/dir/untracked"), "untracked\n").unwrap();
			fs::create_dir_all(temp.path().join("build")).unwrap();
			fs::write(temp.path().join("build/out.txt"), "ignored\n").unwrap();
			git(temp.path(), &["branch", "kept"]);

			let linked = temp.path().join(format!("../linked-keep-{clone:?}"));
			let _ = fs::remove_dir_all(&linked);
			let result = repo
				.worktree_add(&linked, "kept", WorktreeAddOptions {
					detach: false,
					clone,
					keep_changes: true,
				})
				.unwrap();
			if clone == WorktreeClone::Off {
				assert!(result.cloned_with.is_none());
			}

			assert_eq!(fs::read_to_string(linked.join("a")).unwrap(), "staged then edited\n");
			assert!(!linked.join("b").exists());
			assert_eq!(fs::read_to_string(linked.join("new/dir/untracked")).unwrap(), "untracked\n");
			assert_eq!(
				linked.join("build/out.txt").exists(),
				result.cloned_with.is_some(),
				"ignored files ride along only with a clone"
			);
			assert_eq!(
				git(&linked, &["status", "--porcelain"]),
				git(temp.path(), &["status", "--porcelain"]),
				"linked worktree must report the same staged/unstaged/untracked set"
			);
			assert_eq!(git(&linked, &["rev-parse", "HEAD"]), git(temp.path(), &["rev-parse", "HEAD"]));
			assert_eq!(git(&linked, &["symbolic-ref", "HEAD"]), "refs/heads/kept");
			// The source keeps its own dirty state untouched.
			assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "staged then edited\n");

			let rejected = repo.worktree_add(
				&temp.path().join("../linked-keep-rejected"),
				"HEAD~1",
				WorktreeAddOptions { detach: true, clone, keep_changes: true },
			);
			assert!(rejected.is_err(), "keep_changes must require the source HEAD as target");
			let _ = repo.worktree_remove(&linked, true);
		}
	}

	#[test]
	fn mutate_worktree_and_detach() {
		let (temp, repo) = fixture();
		let linked = temp.path().join("../linked-mut");
		let _ = fs::remove_dir_all(&linked);
		repo
			.worktree_add(&linked, "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
			})
			.unwrap();
		assert!(
			git(temp.path(), &["worktree", "list", "--porcelain"])
				.contains(linked.to_string_lossy().as_ref())
		);
		assert!(repo.worktree_remove(&linked, true).unwrap());

		let linked = temp.path().join("../linked-detach");
		let _ = fs::remove_dir_all(&linked);
		repo
			.worktree_add(&linked, "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
			})
			.unwrap();
		let common = fs::canonicalize(repo.info().common_dir.clone()).unwrap();
		let source_head = git(temp.path(), &["rev-parse", "HEAD"]);
		assert_eq!(detach_git_dir(&linked, &common).unwrap(), DetachGitDirResult::Detached);
		let alternates = fs::read_to_string(linked.join(".git/objects/info/alternates")).unwrap();
		assert!(alternates.contains(common.join("objects").to_string_lossy().as_ref()));
		assert_eq!(git(&linked, &["rev-parse", "HEAD"]), git(temp.path(), &["rev-parse", "HEAD"]));
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), source_head);
		assert!(
			!git(temp.path(), &["worktree", "list", "--porcelain"])
				.contains(linked.to_string_lossy().as_ref())
		);
		assert!(repo.worktree_prune().is_ok());
		let _ = fs::remove_dir_all(linked);
	}
	#[test]
	fn release_blocker_commit_rejects_unmerged_index() {
		let (temp, repo) = fixture();
		git(temp.path(), &["checkout", "-qb", "side"]);
		fs::write(temp.path().join("a"), "side\n").unwrap();
		git(temp.path(), &["commit", "-qam", "side"]);
		git(temp.path(), &["checkout", "-q", "main"]);
		fs::write(temp.path().join("a"), "main\n").unwrap();
		git(temp.path(), &["commit", "-qam", "main"]);
		let before = git(temp.path(), &["rev-parse", "HEAD"]);
		let merge = Command::new("git")
			.arg("-C")
			.arg(temp.path())
			.args(["merge", "side"])
			.output()
			.unwrap();
		assert!(!merge.status.success());
		assert!(!git(temp.path(), &["ls-files", "-u"]).is_empty());
		assert!(
			repo
				.commit_create("must fail", &CommitOptions::default())
				.is_err()
		);
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), before);
	}

	#[cfg(unix)]
	#[test]
	fn release_blocker_unmerged_index_skips_pre_commit_hook() {
		let (temp, repo) = fixture();
		git(temp.path(), &["checkout", "-qb", "side"]);
		fs::write(temp.path().join("a"), "side\n").unwrap();
		git(temp.path(), &["commit", "-qam", "side"]);
		git(temp.path(), &["checkout", "-q", "main"]);
		fs::write(temp.path().join("a"), "main\n").unwrap();
		git(temp.path(), &["commit", "-qam", "main"]);
		let merge = Command::new("git")
			.arg("-C")
			.arg(temp.path())
			.args(["merge", "side"])
			.output()
			.unwrap();
		assert!(!merge.status.success());
		write_hook(
			&temp.path().join(".git/hooks/pre-commit"),
			"git add a\necho ran > .git/hook-ran",
			true,
		);
		assert!(
			repo
				.commit_create("must fail", &CommitOptions::default())
				.is_err()
		);
		assert!(!temp.path().join(".git/hook-ran").exists());
		assert!(!git(temp.path(), &["ls-files", "-u"]).is_empty());
	}

	#[cfg(unix)]
	#[test]
	fn release_blocker_stage_and_restore_do_not_follow_symlinks() {
		use std::os::unix::fs::symlink;

		let (temp, repo) = fixture();
		let outside = tempfile::tempdir().unwrap();
		fs::write(outside.path().join("secret"), "outside\n").unwrap();
		symlink(outside.path(), temp.path().join("escape")).unwrap();
		repo.stage_files(&["escape".into()]).unwrap();
		let staged = git(temp.path(), &["ls-files", "--stage", "escape"]);
		assert!(!staged.is_empty());
		assert!(!staged.contains("escape/secret"));
		assert!(repo.stage_files(&["escape/secret".into()]).is_err());

		let sentinel = outside.path().join("sentinel");
		fs::write(&sentinel, "unchanged\n").unwrap();
		fs::remove_file(temp.path().join("a")).unwrap();
		symlink(&sentinel, temp.path().join("a")).unwrap();
		repo
			.restore(&RestoreOptions { files: vec!["a".into()], ..Default::default() })
			.unwrap();
		assert_eq!(fs::read_to_string(&sentinel).unwrap(), "unchanged\n");
		assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "one\n");
		assert!(
			ensure_no_symlink_ancestor(
				temp.path(),
				&temp.path().join(".git/hooks/owned"),
				"git restore",
			)
			.is_err()
		);
	}

	#[test]
	fn release_blocker_worktree_remove_protects_dirty_and_primary() {
		let (temp, repo) = fixture();
		let linked = tempfile::tempdir().unwrap();
		repo
			.worktree_add(linked.path(), "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
			})
			.unwrap();
		fs::write(linked.path().join("a"), "staged\n").unwrap();
		git(linked.path(), &["add", "a"]);
		assert!(!repo.worktree_remove(linked.path(), false).unwrap());
		git(linked.path(), &["reset", "--hard", "HEAD"]);
		fs::write(linked.path().join("untracked"), "keep\n").unwrap();
		assert!(!repo.worktree_remove(linked.path(), false).unwrap());
		assert!(linked.path().join("untracked").exists());
		assert!(!repo.worktree_remove(temp.path(), true).unwrap());
		assert!(temp.path().join(".git").exists());
		assert!(repo.worktree_remove(linked.path(), true).unwrap());
	}

	#[test]
	fn release_blocker_worktree_remove_rejects_nested_root() {
		let (temp, repo) = fixture();
		let linked = tempfile::tempdir().unwrap();
		repo
			.worktree_add(linked.path(), "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
			})
			.unwrap();
		fs::create_dir(linked.path().join("nested")).unwrap();
		fs::write(linked.path().join("nested/file"), "keep\n").unwrap();
		assert!(
			!repo
				.worktree_remove(&linked.path().join("nested"), true)
				.unwrap()
		);
		assert!(linked.path().join("nested/file").exists());
		assert!(
			git(temp.path(), &["worktree", "list", "--porcelain"])
				.contains(linked.path().to_string_lossy().as_ref())
		);
		assert!(repo.worktree_remove(linked.path(), true).unwrap());
	}

	#[test]
	fn release_blocker_worktree_remove_rejects_foreign_common_dir() {
		let (caller_temp, caller) = fixture();
		let (owner_temp, owner) = fixture();
		let linked = tempfile::tempdir().unwrap();
		owner
			.worktree_add(linked.path(), "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
			})
			.unwrap();
		assert!(!caller.worktree_remove(linked.path(), true).unwrap());
		assert!(linked.path().exists());
		assert!(
			git(owner_temp.path(), &["worktree", "list", "--porcelain"])
				.contains(linked.path().to_string_lossy().as_ref())
		);
		assert!(owner.worktree_remove(linked.path(), true).unwrap());
		drop(caller_temp);
	}

	#[cfg(unix)]
	#[test]
	fn release_blocker_stage_applies_clean_filter() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join(".gitattributes"), "filtered.txt filter=upper\n").unwrap();
		git(temp.path(), &["add", ".gitattributes"]);
		git(temp.path(), &["commit", "-qm", "attributes"]);
		drop(repo.gix().unwrap());
		// The clean-filter config is written out of band after the cached open.
		git(temp.path(), &["config", "filter.upper.clean", "tr a-z A-Z"]);
		git(temp.path(), &["config", "filter.upper.required", "true"]);
		fs::write(temp.path().join("filtered.txt"), "lowercase\n").unwrap();
		repo.stage_files(&["filtered.txt".into()]).unwrap();
		assert_eq!(git(temp.path(), &["show", ":filtered.txt"]), "LOWERCASE");
	}

	#[cfg(not(windows))]
	#[test]
	fn restore_accepts_platform_valid_paths() {
		let (temp, repo) = fixture();
		let paths = ["AUX", "a:b"];
		for path in paths {
			fs::write(temp.path().join(path), format!("{path}\n")).unwrap();
		}
		repo.stage_files(&paths.map(str::to_owned)).unwrap();
		repo
			.commit_create("platform paths", &CommitOptions::default())
			.unwrap();
		for path in paths {
			fs::write(temp.path().join(path), "changed\n").unwrap();
		}
		repo
			.restore(&RestoreOptions { files: paths.map(str::to_owned).into(), ..Default::default() })
			.unwrap();
		for path in paths {
			assert_eq!(fs::read_to_string(temp.path().join(path)).unwrap(), format!("{path}\n"));
		}
	}

	#[cfg(unix)]
	#[test]
	fn restore_applies_smudge_filter() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join(".gitattributes"), "filtered.txt filter=upper\n").unwrap();
		git(temp.path(), &["config", "filter.upper.clean", "tr a-z A-Z"]);
		git(temp.path(), &["config", "filter.upper.smudge", "tr A-Z a-z"]);
		git(temp.path(), &["config", "filter.upper.required", "true"]);
		fs::write(temp.path().join("filtered.txt"), "lowercase\n").unwrap();
		git(temp.path(), &["add", ".gitattributes", "filtered.txt"]);
		git(temp.path(), &["commit", "-qm", "filtered"]);
		assert_eq!(git(temp.path(), &["show", "HEAD:filtered.txt"]), "LOWERCASE");

		fs::write(temp.path().join("filtered.txt"), "dirty\n").unwrap();
		repo
			.restore(&RestoreOptions { files: vec!["filtered.txt".into()], ..Default::default() })
			.unwrap();
		assert_eq!(fs::read_to_string(temp.path().join("filtered.txt")).unwrap(), "lowercase\n");
	}

	#[test]
	fn restore_removes_staged_paths_absent_from_source() {
		let (temp, repo) = fixture();
		let added = temp.path().join("added");
		let added_all = temp.path().join("added-all");
		fs::write(&added, "new\n").unwrap();
		fs::write(&added_all, "new\n").unwrap();
		repo
			.stage_files(&["added".into(), "added-all".into()])
			.unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain", "added"]), "A  added");

		repo
			.restore(&RestoreOptions {
				staged: true,
				worktree: true,
				files: vec!["added".into()],
				..Default::default()
			})
			.unwrap();
		assert!(!added.exists());
		assert!(git(temp.path(), &["status", "--porcelain", "added"]).is_empty());
		assert!(added_all.exists());

		repo
			.restore(&RestoreOptions { staged: true, worktree: true, ..Default::default() })
			.unwrap();
		assert!(!added_all.exists());
		assert!(git(temp.path(), &["status", "--porcelain", "added-all"]).is_empty());
	}

	#[test]
	fn checkout_preserves_dirty_and_deleted_unchanged_paths() {
		let (temp, repo) = fixture();
		repo.create_branch("other", "HEAD", false).unwrap();
		fs::write(temp.path().join("b"), "main\n").unwrap();
		repo.stage_files(&["b".into()]).unwrap();
		repo
			.commit_create("main change", &CommitOptions::default())
			.unwrap();

		fs::write(temp.path().join("a"), "dirty\n").unwrap();
		repo.checkout("other").unwrap();
		assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "dirty\n");
		repo.checkout("main").unwrap();
		assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "dirty\n");

		fs::remove_file(temp.path().join("a")).unwrap();
		repo.checkout("other").unwrap();
		assert!(!temp.path().join("a").exists());
	}

	#[test]
	fn checkout_carries_staged_modification_on_unchanged_path() {
		let (temp, repo) = fixture();
		repo.create_branch("other", "HEAD", false).unwrap();
		git(temp.path(), &["checkout", "-q", "other"]);
		fs::write(temp.path().join("b"), "other\n").unwrap();
		git(temp.path(), &["commit", "-qam", "other branch"]);
		git(temp.path(), &["checkout", "-q", "main"]);
		fs::write(temp.path().join("a"), "staged\n").unwrap();
		git(temp.path(), &["add", "a"]);

		repo.checkout("other").unwrap();

		assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "staged\n");
		assert_eq!(git(temp.path(), &["status", "--porcelain", "a"]), "M  a");
		assert_eq!(fs::read_to_string(temp.path().join("b")).unwrap(), "other\n");
	}

	#[test]
	fn checkout_carries_staged_addition_absent_from_both_trees() {
		let (temp, repo) = fixture();
		repo.create_branch("other", "HEAD", false).unwrap();
		git(temp.path(), &["checkout", "-q", "other"]);
		fs::write(temp.path().join("b"), "other\n").unwrap();
		git(temp.path(), &["commit", "-qam", "other branch"]);
		git(temp.path(), &["checkout", "-q", "main"]);
		fs::write(temp.path().join("added"), "staged addition\n").unwrap();
		git(temp.path(), &["add", "added"]);

		repo.checkout("other").unwrap();

		assert_eq!(fs::read_to_string(temp.path().join("added")).unwrap(), "staged addition\n");
		assert_eq!(git(temp.path(), &["status", "--porcelain", "added"]), "A  added");
		assert_eq!(fs::read_to_string(temp.path().join("b")).unwrap(), "other\n");
	}

	#[cfg(unix)]
	#[test]
	fn checkout_refreshes_filter_config() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join(".gitattributes"), "filtered.txt filter=upper\n").unwrap();
		git(temp.path(), &["config", "filter.upper.clean", "tr a-z A-Z"]);
		git(temp.path(), &["config", "filter.upper.smudge", "tr A-Z a-z"]);
		git(temp.path(), &["config", "filter.upper.required", "true"]);
		fs::write(temp.path().join("filtered.txt"), "one\n").unwrap();
		git(temp.path(), &["add", ".gitattributes", "filtered.txt"]);
		git(temp.path(), &["commit", "-qm", "filtered base"]);
		repo.create_branch("other", "HEAD", false).unwrap();

		git(temp.path(), &["config", "filter.upper.clean", "sed 's/^fresh://' | tr a-z A-Z"]);
		git(temp.path(), &["config", "filter.upper.smudge", "tr A-Z a-z | sed 's/^/fresh:/'"]);
		git(temp.path(), &["checkout", "-q", "other"]);
		fs::write(temp.path().join("filtered.txt"), "fresh:two\n").unwrap();
		git(temp.path(), &["add", "filtered.txt"]);
		git(temp.path(), &["commit", "-qm", "filtered target"]);
		git(temp.path(), &["checkout", "-q", "main"]);
		assert_eq!(fs::read_to_string(temp.path().join("filtered.txt")).unwrap(), "fresh:one\n");

		repo.checkout("other").unwrap();
		assert_eq!(fs::read_to_string(temp.path().join("filtered.txt")).unwrap(), "fresh:two\n");
		assert!(git(temp.path(), &["status", "--porcelain"]).is_empty());
	}

	#[test]
	fn checkout_rejects_untracked_blocking_ancestor() {
		let (temp, repo) = fixture();
		repo.create_branch("other", "HEAD", false).unwrap();
		git(temp.path(), &["checkout", "-q", "other"]);
		fs::create_dir(temp.path().join("dir")).unwrap();
		fs::write(temp.path().join("dir/file"), "target\n").unwrap();
		git(temp.path(), &["add", "dir/file"]);
		git(temp.path(), &["commit", "-qm", "add nested file"]);
		git(temp.path(), &["checkout", "-q", "main"]);
		fs::write(temp.path().join("dir"), "untracked blocker\n").unwrap();

		assert!(matches!(repo.checkout("other"), Err(Error::Conflict { .. })));
		assert_eq!(fs::read_to_string(temp.path().join("dir")).unwrap(), "untracked blocker\n");
		assert_eq!(git(temp.path(), &["symbolic-ref", "--short", "HEAD"]), "main");
	}

	#[cfg(unix)]
	#[test]
	fn checkout_recreates_non_executable_target() {
		use std::os::unix::fs::PermissionsExt;

		let (temp, repo) = fixture();
		repo.create_branch("plain", "HEAD", false).unwrap();
		let path = temp.path().join("a");
		let mut permissions = fs::metadata(&path).unwrap().permissions();
		permissions.set_mode(0o755);
		fs::set_permissions(&path, permissions).unwrap();
		git(temp.path(), &["add", "a"]);
		git(temp.path(), &["commit", "-qm", "make executable"]);

		repo.checkout("plain").unwrap();
		assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o111, 0);
		assert!(git(temp.path(), &["status", "--porcelain"]).is_empty());
	}

	#[cfg(unix)]
	#[test]
	fn checkout_detects_type_changes_without_following_symlinks() {
		use std::os::unix::fs::symlink;

		let (temp, repo) = fixture();
		repo.create_branch("other", "HEAD", false).unwrap();
		git(temp.path(), &["checkout", "-q", "other"]);
		fs::write(temp.path().join("a"), "target\n").unwrap();
		git(temp.path(), &["commit", "-qam", "target"]);
		git(temp.path(), &["checkout", "-q", "main"]);
		let outside = tempfile::NamedTempFile::new().unwrap();
		fs::write(outside.path(), "one\n").unwrap();
		fs::remove_file(temp.path().join("a")).unwrap();
		symlink(outside.path(), temp.path().join("a")).unwrap();

		assert!(matches!(repo.checkout("other"), Err(Error::Conflict { .. })));
		assert!(
			fs::symlink_metadata(temp.path().join("a"))
				.unwrap()
				.file_type()
				.is_symlink()
		);
		assert_eq!(fs::read_to_string(outside.path()).unwrap(), "one\n");
	}

	#[cfg(unix)]
	#[test]
	fn hard_reset_does_not_follow_symlink_ancestors() {
		use std::os::unix::fs::symlink;

		let (temp, repo) = fixture();
		let base = git(temp.path(), &["rev-parse", "HEAD"]);
		fs::create_dir(temp.path().join("d")).unwrap();
		fs::write(temp.path().join("d/victim"), "tracked\n").unwrap();
		git(temp.path(), &["add", "d/victim"]);
		git(temp.path(), &["commit", "-qm", "tracked nested file"]);
		let current = git(temp.path(), &["rev-parse", "HEAD"]);
		fs::remove_dir_all(temp.path().join("d")).unwrap();
		let outside = tempfile::tempdir().unwrap();
		let sentinel = outside.path().join("victim");
		fs::write(&sentinel, "outside\n").unwrap();
		symlink(outside.path(), temp.path().join("d")).unwrap();

		assert!(repo.reset(ResetMode::Hard, Some(&base)).is_err());
		assert_eq!(fs::read_to_string(&sentinel).unwrap(), "outside\n");
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), current);
	}

	#[test]
	fn restore_handles_file_directory_transitions() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join("shape"), "file\n").unwrap();
		git(temp.path(), &["add", "shape"]);
		git(temp.path(), &["commit", "-qm", "file shape"]);
		let file_commit = git(temp.path(), &["rev-parse", "HEAD"]);

		fs::remove_file(temp.path().join("shape")).unwrap();
		fs::create_dir(temp.path().join("shape")).unwrap();
		fs::write(temp.path().join("shape/child"), "child\n").unwrap();
		git(temp.path(), &["add", "-A"]);
		git(temp.path(), &["commit", "-qm", "directory shape"]);
		let directory_commit = git(temp.path(), &["rev-parse", "HEAD"]);

		repo
			.restore(&RestoreOptions {
				source: Some(file_commit),
				files: vec!["shape".into()],
				..Default::default()
			})
			.unwrap();
		assert_eq!(fs::read_to_string(temp.path().join("shape")).unwrap(), "file\n");

		repo
			.restore(&RestoreOptions {
				source: Some(directory_commit),
				files: vec!["./shape".into()],
				..Default::default()
			})
			.unwrap();
		assert_eq!(fs::read_to_string(temp.path().join("shape/child")).unwrap(), "child\n");
	}

	#[cfg(unix)]
	#[test]
	fn restore_keeps_index_when_worktree_update_fails() {
		use std::os::unix::fs::symlink;

		let (temp, repo) = fixture();
		fs::create_dir(temp.path().join("d")).unwrap();
		fs::write(temp.path().join("d/victim"), "base\n").unwrap();
		git(temp.path(), &["add", "d/victim"]);
		git(temp.path(), &["commit", "-qm", "tracked nested file"]);
		fs::write(temp.path().join("d/victim"), "staged\n").unwrap();
		git(temp.path(), &["add", "d/victim"]);
		let index_path = temp.path().join(".git/index");
		let index_before = fs::read(&index_path).unwrap();
		fs::remove_dir_all(temp.path().join("d")).unwrap();
		let outside = tempfile::tempdir().unwrap();
		let sentinel = outside.path().join("victim");
		fs::write(&sentinel, "outside\n").unwrap();
		symlink(outside.path(), temp.path().join("d")).unwrap();

		assert!(
			repo
				.restore(&RestoreOptions {
					staged: true,
					worktree: true,
					files: vec!["d/victim".into()],
					..Default::default()
				})
				.is_err()
		);
		assert_eq!(fs::read(&index_path).unwrap(), index_before);
		assert_eq!(fs::read_to_string(&sentinel).unwrap(), "outside\n");
	}

	#[test]
	fn restore_rejects_unmerged_index_source() {
		let (temp, repo) = fixture();
		git(temp.path(), &["checkout", "-qb", "side"]);
		fs::write(temp.path().join("a"), "side\n").unwrap();
		git(temp.path(), &["commit", "-qam", "side"]);
		git(temp.path(), &["checkout", "-q", "main"]);
		fs::write(temp.path().join("a"), "main\n").unwrap();
		git(temp.path(), &["commit", "-qam", "main"]);
		let merge = Command::new("git")
			.arg("-C")
			.arg(temp.path())
			.args(["merge", "side"])
			.output()
			.unwrap();
		assert!(!merge.status.success());
		let index_before = fs::read(temp.path().join(".git/index")).unwrap();

		assert!(matches!(
			repo.restore(&RestoreOptions { files: vec!["a".into()], ..Default::default() }),
			Err(Error::Conflict { .. })
		));
		assert_eq!(fs::read(temp.path().join(".git/index")).unwrap(), index_before);
	}

	#[test]
	fn restore_rejects_sparse_and_unmatched_paths() {
		let (temp, repo) = fixture();
		git(temp.path(), &["update-index", "--skip-worktree", "a"]);
		fs::write(temp.path().join("a"), "dirty\n").unwrap();
		assert!(
			repo
				.restore(&RestoreOptions { files: vec!["a".into()], ..Default::default() })
				.is_err()
		);
		assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "dirty\n");
		assert!(
			repo
				.restore(&RestoreOptions {
					staged: true,
					files: vec!["a".into()],
					..Default::default()
				})
				.is_err()
		);
		assert!(
			repo
				.restore(&RestoreOptions { files: vec!["missing".into()], ..Default::default() })
				.is_err()
		);
		assert!(
			repo
				.restore(&RestoreOptions { files: vec![String::new()], ..Default::default() })
				.is_err()
		);
	}

	#[test]
	fn restore_rejects_descendant_of_collapsed_sparse_directory() {
		let (temp, repo) = fixture();
		fs::create_dir_all(temp.path().join("included")).unwrap();
		fs::create_dir_all(temp.path().join("vendor")).unwrap();
		fs::write(temp.path().join("included/file"), "included\n").unwrap();
		fs::write(temp.path().join("vendor/file"), "excluded\n").unwrap();
		git(temp.path(), &["add", "included/file", "vendor/file"]);
		git(temp.path(), &["commit", "-qm", "sparse tree"]);
		git(temp.path(), &["sparse-checkout", "init", "--cone", "--sparse-index"]);
		git(temp.path(), &["sparse-checkout", "set", "included"]);
		assert!(!temp.path().join("vendor/file").exists());
		let index = load_index_or_head(&repo.gix().unwrap(), "test").unwrap();
		assert!(index.entries().iter().any(|entry| {
			entry.mode == gix::index::entry::Mode::DIR
				&& entry
					.flags
					.contains(gix::index::entry::Flags::SKIP_WORKTREE)
		}));
		let index_before = fs::read(temp.path().join(".git/index")).unwrap();

		assert!(
			repo
				.restore(&RestoreOptions {
					source: Some("HEAD".into()),
					worktree: true,
					files: vec!["vendor/file".into()],
					..Default::default()
				})
				.is_err()
		);
		assert!(!temp.path().join("vendor/file").exists());
		assert_eq!(fs::read(temp.path().join(".git/index")).unwrap(), index_before);
	}

	#[test]
	fn sparse_checkout_modes_fail_before_side_effects() {
		for index_mode in ["--sparse-index", "--no-sparse-index"] {
			let (temp, repo) = fixture();
			fs::create_dir_all(temp.path().join("included")).unwrap();
			fs::create_dir_all(temp.path().join("vendor")).unwrap();
			fs::write(temp.path().join("included/file"), "included\n").unwrap();
			fs::write(temp.path().join("vendor/file"), "base\n").unwrap();
			git(temp.path(), &["add", "included/file", "vendor/file"]);
			git(temp.path(), &["commit", "-qm", "sparse base"]);
			repo.create_branch("other", "HEAD", false).unwrap();
			git(temp.path(), &["checkout", "-q", "other"]);
			fs::write(temp.path().join("vendor/file"), "target\n").unwrap();
			git(temp.path(), &["commit", "-qam", "change excluded file"]);
			let target = git(temp.path(), &["rev-parse", "HEAD"]);
			git(temp.path(), &["checkout", "-q", "main"]);
			git(temp.path(), &["sparse-checkout", "init", "--cone", index_mode]);
			git(temp.path(), &["sparse-checkout", "set", "included"]);

			let sparse_index = load_index_or_head(&repo.gix().unwrap(), "test").unwrap();
			assert!(sparse_index.entries().iter().any(|entry| {
				entry
					.flags
					.contains(gix::index::entry::Flags::SKIP_WORKTREE)
			}));
			assert_eq!(sparse_index.is_sparse(), index_mode == "--sparse-index");
			let head_before = git(temp.path(), &["rev-parse", "HEAD"]);
			let index_path = temp.path().join(".git/index");
			let index_before = fs::read(&index_path).unwrap();
			assert!(!temp.path().join("vendor/file").exists());

			let checkout_error = repo.checkout("other").unwrap_err();
			assert!(checkout_error.to_string().contains("sparse checkout"));
			assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), head_before);
			assert_eq!(fs::read(&index_path).unwrap(), index_before);
			assert!(!temp.path().join("vendor/file").exists());

			let reset_error = repo.reset(ResetMode::Hard, Some(&target)).unwrap_err();
			assert!(reset_error.to_string().contains("sparse checkout"));
			assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), head_before);
			assert_eq!(fs::read(&index_path).unwrap(), index_before);
			assert!(!temp.path().join("vendor/file").exists());

			let linked_parent = tempfile::tempdir().unwrap();
			let linked = linked_parent.path().join("linked");
			let worktree_error = repo
				.worktree_add(&linked, &target, WorktreeAddOptions {
					detach:       false,
					clone:        WorktreeClone::Off,
					keep_changes: false,
				})
				.unwrap_err();
			assert!(worktree_error.to_string().contains("sparse checkout"));
			assert!(!linked.exists());
			let branch = format!("refs/heads/{target}");
			assert!(
				!Command::new("git")
					.arg("-C")
					.arg(temp.path())
					.args(["show-ref", "--verify", "--quiet", &branch])
					.status()
					.unwrap()
					.success()
			);
		}
	}

	#[test]
	fn restore_normalizes_dot_pathspecs() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join("a"), "dirty\n").unwrap();
		repo
			.restore(&RestoreOptions { files: vec!["./a".into()], ..Default::default() })
			.unwrap();
		assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "one\n");
		fs::write(temp.path().join("a"), "dirty again\n").unwrap();
		fs::write(temp.path().join("b"), "dirty too\n").unwrap();
		repo
			.restore(&RestoreOptions { files: vec![".".into()], ..Default::default() })
			.unwrap();
		assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "one\n");
		assert_eq!(fs::read_to_string(temp.path().join("b")).unwrap(), "two\n");
	}

	#[cfg(all(unix, not(target_os = "macos")))]
	#[test]
	fn restore_and_reset_preserve_non_utf8_paths() {
		use std::{ffi::OsString, os::unix::ffi::OsStringExt};

		let (temp, repo) = fixture();
		let path = temp
			.path()
			.join(OsString::from_vec(b"non-\xff-utf8".to_vec()));
		fs::write(&path, "base\n").unwrap();
		git(temp.path(), &["add", "."]);
		git(temp.path(), &["commit", "-qm", "non utf8 base"]);
		let base = git(temp.path(), &["rev-parse", "HEAD"]);
		fs::write(&path, "dirty\n").unwrap();
		repo.restore(&RestoreOptions::default()).unwrap();
		assert_eq!(fs::read_to_string(&path).unwrap(), "base\n");

		fs::write(&path, "next\n").unwrap();
		git(temp.path(), &["add", "."]);
		git(temp.path(), &["commit", "-qm", "non utf8 next"]);
		repo.reset(ResetMode::Hard, Some(&base)).unwrap();
		assert_eq!(fs::read_to_string(&path).unwrap(), "base\n");
	}

	#[test]
	fn checkout_outcome_rejects_unprocessed_paths() {
		let mut outcome = gix::worktree::state::checkout::Outcome::default();
		outcome.delayed_paths_unprocessed.push("delayed".into());
		assert!(validate_checkout_outcome("git checkout", &outcome).is_err());
	}

	#[test]
	fn clone_first_falls_back_for_gitlinks_and_rejects_keep_changes() {
		let (temp, repo) = fixture();
		let head = git(temp.path(), &["rev-parse", "HEAD"]);
		let cache_info = format!("160000,{head},sub");
		git(temp.path(), &["update-index", "--add", "--cacheinfo", &cache_info]);
		git(temp.path(), &["commit", "-qm", "add gitlink"]);

		let linked = temp.path().join("../linked-gitlink-fallback");
		let rejected = temp.path().join("../linked-gitlink-keep");
		let _ = fs::remove_dir_all(&linked);
		let _ = fs::remove_dir_all(&rejected);
		let result = repo
			.worktree_add(&linked, "HEAD", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Auto,
				keep_changes: false,
			})
			.unwrap();
		assert!(result.cloned_with.is_none());
		assert!(
			result
				.clone_error
				.as_deref()
				.is_some_and(|error| error.contains("submodules"))
		);
		assert!(linked.join("sub").is_dir());
		assert!(git(&linked, &["status", "--porcelain"]).is_empty());
		assert!(
			repo
				.worktree_add(&rejected, "HEAD", WorktreeAddOptions {
					detach:       true,
					clone:        WorktreeClone::Auto,
					keep_changes: true,
				})
				.is_err()
		);
		assert!(!rejected.exists());
		assert!(repo.worktree_remove(&linked, true).unwrap());
	}

	#[cfg(unix)]
	#[test]
	fn clone_reconciliation_does_not_follow_symlink_ancestors() {
		use std::os::unix::fs::symlink;

		let (temp, repo) = fixture();
		fs::create_dir(temp.path().join("d")).unwrap();
		fs::write(temp.path().join("d/victim"), "tracked\n").unwrap();
		git(temp.path(), &["add", "d/victim"]);
		git(temp.path(), &["commit", "-qm", "tracked nested file"]);
		repo.create_branch("target", "HEAD", false).unwrap();
		git(temp.path(), &["checkout", "-q", "target"]);
		git(temp.path(), &["rm", "-q", "d/victim"]);
		git(temp.path(), &["commit", "-qm", "remove nested file"]);
		git(temp.path(), &["checkout", "-q", "main"]);
		fs::remove_dir_all(temp.path().join("d")).unwrap();
		let outside = tempfile::tempdir().unwrap();
		let sentinel = outside.path().join("victim");
		fs::write(&sentinel, "outside\n").unwrap();
		symlink(outside.path(), temp.path().join("d")).unwrap();

		let linked = temp.path().join("../linked-clone-symlink");
		let _ = fs::remove_dir_all(&linked);
		let result = repo
			.worktree_add(&linked, "target", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Auto,
				keep_changes: false,
			})
			.unwrap();
		assert_eq!(fs::read_to_string(&sentinel).unwrap(), "outside\n");
		if !pi_iso::clone_candidates(None).is_empty() {
			assert!(result.cloned_with.is_none());
			assert!(result.clone_error.is_some());
		}
		assert!(!linked.join("d").exists());
		assert!(repo.worktree_remove(&linked, true).unwrap());
	}

	#[test]
	fn checkout_filter_context_uses_target_identity() {
		let (_temp, repo) = fixture();
		let gix = repo.gix().unwrap();
		let id = gix.head_id().unwrap().detach();
		let mut options = gix
			.checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping)
			.unwrap();
		set_filter_context(&mut options, Some(id), FilterRef::Set(Some("refs/heads/target")));
		let context = options.filters.driver_context_mut();
		assert_eq!(context.treeish, Some(id));
		assert_eq!(
			context.ref_name.as_ref().map(|name| name.as_bstr()),
			Some(b"refs/heads/target".as_bstr())
		);
		set_filter_context(&mut options, None, FilterRef::Set(None));
		assert!(options.filters.driver_context_mut().ref_name.is_none());
	}

	#[test]
	fn checkout_preserves_staged_changes_on_affected_paths() {
		let (temp, repo) = fixture();
		repo.create_branch("other", "HEAD", false).unwrap();
		git(temp.path(), &["checkout", "-q", "other"]);
		fs::write(temp.path().join("a"), "other\n").unwrap();
		git(temp.path(), &["commit", "-qam", "other"]);
		git(temp.path(), &["checkout", "-q", "main"]);
		fs::write(temp.path().join("a"), "staged\n").unwrap();
		git(temp.path(), &["add", "a"]);
		let index_before = fs::read(temp.path().join(".git/index")).unwrap();

		assert!(matches!(repo.checkout("other"), Err(Error::Conflict { .. })));
		assert_eq!(fs::read(temp.path().join(".git/index")).unwrap(), index_before);
		assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "staged\n");
	}

	#[test]
	fn checkout_does_not_write_through_initialized_gitlink_ancestor() {
		let (temp, repo) = fixture();
		repo.create_branch("target", "HEAD", false).unwrap();
		git(temp.path(), &["checkout", "-q", "target"]);
		fs::create_dir(temp.path().join("sub")).unwrap();
		fs::write(temp.path().join("sub/file"), "target\n").unwrap();
		git(temp.path(), &["add", "sub/file"]);
		git(temp.path(), &["commit", "-qm", "target directory"]);
		git(temp.path(), &["checkout", "-q", "main"]);

		let nested = tempfile::tempdir().unwrap();
		git(nested.path(), &["init", "-q", "-b", "main"]);
		git(nested.path(), &["config", "user.name", "Test"]);
		git(nested.path(), &["config", "user.email", "test@example.com"]);
		fs::write(nested.path().join("nested"), "nested\n").unwrap();
		git(nested.path(), &["add", "."]);
		git(nested.path(), &["commit", "-qm", "nested"]);
		let nested_head = git(nested.path(), &["rev-parse", "HEAD"]);
		let cache_info = format!("160000,{nested_head},sub");
		git(temp.path(), &["update-index", "--add", "--cacheinfo", &cache_info]);
		git(temp.path(), &["commit", "-qm", "gitlink"]);
		git(temp.path(), &["clone", "-q", nested.path().to_str().unwrap(), "sub"]);

		assert!(matches!(repo.checkout("target"), Err(Error::Conflict { .. })));
		assert_eq!(fs::read_to_string(temp.path().join("sub/nested")).unwrap(), "nested\n");
		assert!(temp.path().join("sub/.git").exists());
	}
}
