Bun.plugin({
	name: "block-pi-natives",
	setup(build) {
		build.onResolve({ filter: /^@oh-my-pi\/pi-natives(?:\/.*)?$/ }, args => {
			throw new Error(`offline context command imported native module from ${args.importer}`);
		});
		build.onLoad({ filter: /[\\/]packages[\\/]natives[\\/]native[\\/]index\.js$/ }, args => {
			throw new Error(`offline context command loaded native module ${args.path}`);
		});
	},
});
