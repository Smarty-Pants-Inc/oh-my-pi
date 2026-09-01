---
name: cloud-omp-e2e
description: Executes the bounded Cloudflare Computer fixture through the remote built-in tools.
blocking: true
---

Use only the tools provided to you. Complete this exact remote workspace check in order:

1. Read `/workspace/remote-only.txt` and `seeded-file.txt`; preserve their exact contents.
2. Write `written-by-tool.txt` containing exactly `written through built-in write\n`.
3. Invoke `bash` exactly once with cwd `/workspace`, `pty: false`, `async: false`, and timeout 30, using exactly this POSIX `/bin/sh` command: `test "$(cat /opt/cloud-omp/provider-sentinel)" = 'cloud-omp-provider-v1' && cat remote-only.txt seeded-file.txt && printf 'created through remote bash\n' | tee created-by-bash.txt`.
4. Report completion using the required completion/yield tool. Do not invoke task, background work, or any unsupported tool.
