# Product ideas

These are just _ideas_ for features we might want to add at some point. Various noodlings.

Note: we have moved IDEAS onto the Github discussion: https://github.com/freeflow-im/flow/discussions/52

# Blockers to using agents

-One big blocker for Flow is building and deploying native apps. Once the agent has verified
some new work it should be able to merge that PR and deploy the latest version of the macOS
or iOS app. I think this is mostly doable if we setup publishing keys on the VPS. Obviously
pushing on iOS only really works with TestFlight, so anyone doing iOS dev should be using
TestFlight to install. Or even better if we just setup CI/CD on Github to automatically
publish when changes are merged to either app. That way the agents dont have to worry about it.

## Coordinating multiple agents

We need a central task queue. Agents can be dispatched to work on a task and they should 
"grab it" so that other agents don't try to work on it.


