# Definition of done

A story on the planning board is **Done** only when the evidence below is recorded on the card. "Works on my machine" and "implemented but not committed" are **In review**, never Done.

## Two kinds of story

| Kind | How to tell | Done means |
|---|---|---|
| **UI work** | The story has the label `frontend` (anything people see in a browser: views, CSS, client scripts, layouts) | acceptance criteria met, checks green, **committed and pushed**, then **deployed to production and verified there** |
| **Backend / other work** | Every other story (`backend`, `database`, `security`, `devops`, `testing`, `docs`) | acceptance criteria met, checks green, **committed and pushed** |

A story that mixes both (has `frontend` among its labels) follows the UI rule.

## The sequence

1. Build it and satisfy every acceptance criterion.
2. Run the checks: `npx tsc --noEmit`, `npx tsc -p tsconfig.test.json`, `npm run lint`, `npx jest`; for UI work also the browser suites (`BROWSER_TESTS=1 npx jest tests/browser --runInBand`).
3. Commit. Record the commit SHA on the card.
4. Push the commit to the remote (`git push -u origin <branch>`), then confirm it is there (`git ls-remote origin <branch>` shows the commit, or a later one). Record the branch name on the card. A commit that exists only on one machine is not done.
5. UI work only: deploy to production from the committed tree, then check the live site (status codes and a marker that proves the new version is serving). Record the deployment URL on the card.
6. Only now move the card to **Done**.

Deploys upload the working tree, so deploy from a tree whose HEAD is the commit you recorded and whose story files have no uncommitted changes.

## How the board enforces it

- A card cannot be saved as Done without a commit SHA (7 to 40 hex characters) and the branch it was pushed to, and a UI card also needs a deployment URL or id.
- A card that is marked Done without that evidence (for example edited outside the page) is shown as **Not verified done** and does not count toward milestone progress.
- Whoever sets a card to Done, human or Claude, records the evidence in the same write.
