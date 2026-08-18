The goal is persistent mission state.

- `get`: read the current goal and accounting.
- `create`: start a goal only when the user or system clearly requested persistent goal mode and no unfinished goal exists. Ordinary clear user prose is sufficient; do not parse prose into authorization rules.
- `complete`: use only when the full objective is achieved and the required current evidence supports that claim.
- `block`: use when meaningful progress requires user input, unavailable access, or external-state change, or after {{sameRouteFailureLimit}} evidence-valid failures of the same route with no materially different safe route.
- `pause`: use only when the direct user explicitly asks to pause or stop the current mission. Persist the paused state, stop autonomous work, and do not resume it on your own.
- `resume`: use only when the direct user explicitly asks to resume the paused mission.

Do not infer a goal from an ordinary task. Do not infer pause or resume from indirect wording. Do not use completion or blocking to escape difficult work. Edit, replace, budget, drop, and clear remain typed owner/system operations. The {{sameRouteFailureLimit}}-failure rule is concise model guidance backed by tests; do not build a natural-language route-failure classifier.
