My guidelines
Creating a branch:
    -Any modified files should be carried over without staging
    -Agent should ask if branch has task/issue number and branch type (feature or fix)
    -The branch name should be <type>/<task or issue number if present>-<Description of work>
    -Shuold never lose changes when creating a new branch. NEVER.

Commiting:
    - When asked to commit changes made, should look at modified files and suggest a commit plan
    - Instead of just commiting all files in a big commit and using llm to generate a git message, we should use the llm to evaluate changes made on all the files and if necessary split into multiple commits, each one with his own context/message, like

    commit 1: <task or issue number if present> - Updated form validations
        files form.ts, form-values.ts
    commit 2: <task or issue number if present> - Fixed issue with current state when page loads
        files: state.ts, state-values.ts

    This should follow best practices when doing commits

    Should look for any local changes that are just for local development and should not be commited like env files, local dev configurations made for testing etc
    Should also look for commit templates on the existing repo

Pushing:
    Nothing much here, just don't let it use force push in any case

Creating a PR:

Should have a name on the same pattern as the branch
<type>/<task or issue number if present>-<Description of work>

A summary of changes, and a small test plan for those. Can split into multiple test plans if it's necessary. Should confirm/ask the target branch, with the default being the base branch from wich the current one was created.

-Update branch based on another
    Nothing special here, just merge the desired branch into the current one, if conflicts are found is let to the user to fix them. We should be able to continue the merge once the conflicts are solved. 


Why now? I just want to create this for learning/portifolio purposes.
Who uses it? Mostly me, but it shuold be able to be used by anyone ho installs it and has claude code and gh cli installed and authenticated.
I want to use it like I use bmad, install in the repo with npx, and call a skill to trigger it like /git-agent-create-branch etc