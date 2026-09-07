# The portal

Part of the [werk product specification](../product-specification.md). Nothing
here is settled.

The portal is what a company installs. The name is a placeholder and the design
has not been worked through.

It lets someone configure how terminals are used at that company. The part that
carries the most weight is configuring the **hosts** those terminals run on, and
configuring the **workspaces** provisioned on those hosts. That is the broad
capability. Specific things built on it include central management of which
agents people are allowed to use and how those agents authenticate.

This is plausibly useful beyond running AI agents. Making everyone's development
tools the same (the same editor, the same diff tool, managed dev containers on
managed machines) looks like the first broad capability the portal enables, and
it does not mention agents at all.

The logs are the portal's other half. Logs plus sharing let people search and
review each other's sessions. A CTO should be able to see who is running which
agents, and what those agents are doing right now.
