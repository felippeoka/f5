# PR Hub accounts and forges

Review and act on pull requests from GitHub, GitLab, Bitbucket Cloud, Azure DevOps and
Forgejo/Gitea without leaving F5. Each repository can use its own account.

> [!NOTE]
> This page has no screenshot because the PR Hub needs a connected forge account to show
> anything.

## How to

1. Open **Pull requests** and click **Manage accounts**.
2. Add a token for your forge host. F5 verifies it with the host before saving it. Azure DevOps
   also needs an organization.
3. If several accounts match a repository, add a repository route that picks one.
4. Open a pull request to read its diff, comment, review or merge.

The existing GitHub setup stays the default as the legacy profile account.

## Finding pull requests

The **Inbox** and **Focus** views list tracked pull requests. Attention filters such as **Needs
you**, **Needs my review**, **CI failing** and **Ready** narrow the list, and you can also filter by
repository, CI or lifecycle. Each pull request has **Summary**, **Timeline**, **Review threads**
and **Files** tabs.

## Safe actions

Every action that changes a pull request is prepared first. F5 shows the account and the exact
revision it will act on, and sends the action once you confirm. If a response gets lost,
**Check saved operation** looks for proof on the forge instead of sending again. Once you have
checked the forge yourself, **Acknowledge verified outcome** clears the operation without
resending it.

## Reviewing changes

Inline comments are tied to the exact head and base you compared. If either changes, refresh
before commenting. **Viewed** marks also belong to that revision, so a new push clears them.
Hover a PR link to preview it, copy it, or open it in the hub. **Send to agent** puts a diff
comment into the linked thread's composer without sending it.

## What each forge supports

| Forge         | Comments | Approve / request changes | Branch updates | Merge         |
| ------------- | -------- | ------------------------- | -------------- | ------------- |
| GitHub        | Yes      | Yes                       | Yes            | Yes           |
| GitLab        | Yes      | Approve                   | Rebase         | Yes           |
| Bitbucket     | Yes      | Yes                       | No             | No            |
| Azure DevOps  | No       | No                        | No             | Merge, squash |
| Forgejo/Gitea | Yes      | Yes                       | Merge, rebase  | Yes           |

Only actions the forge advertises are shown, and GitHub permissions can narrow them further. Only
GitHub has native stacks.

## Good to know

- Tokens stay in the profile's server secret store and never reach the browser.
- Removing an account also removes its repository routes and stored token.
- When a refresh fails, cached data stays visible with a stale warning.
- PR markdown can show authenticated GitHub images and videos. Other HTML is escaped.

<details>
<summary>Details and limits</summary>

- Tokens are stored per host, verified login and credential generation. Replacing a token resets
  that account's runtime and caches. Selecting an account never changes a process-wide
  credential.
- Monitoring and request budgets are owned by the server and account, not by an open panel. Reads,
  pagination and account runtimes are bounded.
- An unresolved operation blocks preparing another change for that pull request. Outstanding
  operations are shown in every panel and client.
- GitLab and Bitbucket reviews save the comment and the verdict as separate steps, so a recovered
  comment is never mistaken for an accepted verdict. Stack actions check each layer's revision
  and keep partial progress.
- Bitbucket merges are disabled because its endpoint can't enforce the prepared head commit.
  Forgejo has no review-thread reply/resolve or draft conversion.
- Azure reviewer replacement adds new reviewers before removing old ones. These calls aren't
  atomic, so check the reviewer list after an interruption.
- GitHub stores viewed marks on the host; other forges store them in F5.
- The media proxy allows GitHub user attachments, GitHubusercontent hosts and configured
  Enterprise hosts. Tokens go only to their own host, including through redirects. Media is
  limited to 100 MB and supports single byte ranges.
- Stacks are hidden on hosts that return 404 or 422.
- A thread can link several pull requests, even from different forges.

</details>

## Related

- [Project settings](project-settings.md) (per-project merge method)
- [Worktrees and storage automation](worktrees-and-storage-automation.md)
