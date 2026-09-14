# HTTP request workflow

org.http is a copy/paste-friendly request collection for VS Code's REST Client
extension (or any editor that understands the common .http format). Set the
cookie, CSRF, organization and principal variables at the top, then use each
request's Send Request action.

For terminal runs, run_org_curls.py shells out to the real curl binary:

    N2F_OWNER_COOKIE='n2f_session=...; n2f_csrf=...' \
    N2F_OWNER_CSRF='...' \
    N2F_ORGANIZATION_ID='...' \
    N2F_INVITEE_PRINCIPAL_ID='...' \
    N2F_INVITEE_COOKIE='n2f_session=...; n2f_csrf=...' \
    N2F_INVITEE_CSRF='...' \
    python3 tools/run_org_curls.py

The runner verifies the owner list, creates an invitation, accepts it as the
invitee, promotes the member to admin and confirms the role through a second
read. Omit the invitee credentials to run only the owner invitation step.

In Neovim, the closest `.http` workflow is [kulala.nvim](https://github.com/mistweaverco/kulala.nvim); [rest.nvim](https://github.com/rest-nvim/rest.nvim) is also a good lightweight choice. Both provide request execution from a Neovim buffer, with Kulala generally offering the smoother interactive request history and environment handling. The collection remains executable from the shell so the editor plugin is optional.
