# Document transport layer

The first HTTP transport exposes authenticated organization-scoped create,
list, get and archive operations. It only parses route/body/authentication
values, opens provenance-aware work and maps application results to JSON. The
Document domain and application layers remain the source of rules.
