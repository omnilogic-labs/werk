# The portal

Part of the [werk product specification](../product-specification.md). Nothing
here is settled, and nothing described here is built: the specification records
that nothing of the portal exists.

The portal would be what a company installs. The name is a placeholder and the
design has not been worked through.

The capability it is meant to carry is letting someone configure how terminals
are used at that company. The part that looks like it carries the most weight is
configuring the **hosts** those terminals run on, and configuring the
**workspaces** provisioned on those hosts. Specific things that could be built
on that include central management of which agents people are allowed to use and
how those agents authenticate.

This is plausibly useful beyond running AI agents. Making everyone's development
tools the same (the same editor, the same diff tool, managed dev containers on
managed machines) looks like the first broad capability a portal would enable,
and it does not mention agents at all.

The logs are likely to be the portal's other half. Logs plus sharing would let
people search and review each other's sessions. A CTO being able to see who is
running which agents, and what those agents are doing right now, is the case
that suggests it.
