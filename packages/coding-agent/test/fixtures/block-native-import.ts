Bun.plugin({
	name: "block-pi-natives",
	setup(build) {
		build.onResolve({ filter: /(?:^|\/)natives\/native(?:\/index\.js)?$/ }, args => {
			throw new Error(`offline context command resolved native module ${args.path} from ${args.importer}`);
		});
		build.onResolve({ filter: /native\/index\.js$/ }, args => {
			if (args.importer.includes("/packages/natives/")) {
				throw new Error(`offline context command resolved native module ${args.path} from ${args.importer}`);
			}
		});
		build.onResolve({ filter: /^@oh-my-pi\/pi-natives(?:\/.*)?$/ }, args => {
			throw new Error(`offline context command imported native module from ${args.importer}`);
		});
		build.onLoad({ filter: /[\\/]packages[\\/]natives[\\/]native[\\/]index\.js$/ }, args => {
			throw new Error(`offline context command loaded pi_natives module ${args.path}`);
		});
	},
});
