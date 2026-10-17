# Workflows

A workflow runs one piece of work through several agents, each on the provider, model and reasoning effort you pick for its slot. F5 creates a thread for every stage, so you can open any step and read exactly what that agent did.

<p align="center">
  <img src="../../assets/screenshots/new-workflow.png" alt="New workflow dialog with Feature, Code Review, Investigation and Document types and a model row per slot" width="800" />
</p>

## Start a run

1. Click **New workflow** in the sidebar or on Home, or press `Mod+Shift+N`.
2. Pick a type: **Feature**, **Code Review**, **Investigation** or **Document**.
3. Describe the work in the text box. You can attach files; their paths are added to the prompt. F5 generates the title from your prompt with the thread title model.
4. Under **Models**, choose a provider, model and reasoning effort for each slot.
5. Open **Options** if you need them (see below), then click **Start workflow** (`Mod+Enter`).

The run belongs to the project selected on Home or in the sidebar.

## The four types

| Type          | Stages                                                                                   | Slots in the dialog                       |
| ------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------- |
| Feature       | Authoring, reviews, revision, merge. Implementation and code review run when you ask.    | Author A, Author B, Merge                 |
| Code Review   | Two independent reviews, then consolidation into one ranked report.                      | Reviewer A, Reviewer B, Consolidation     |
| Investigation | Two investigations, cross-review, optional self-review, then a synthesis that answers.   | Investigator A, Investigator B, Synthesis |
| Document      | Two drafts, reviews and revisions, a merge, and an optional reader review of the result. | Author A, Author B, Merge model, Reader   |

**Feature.** Two authors draft competing plans for the same requirement. Each reviews the other's plan (and its own, with own-model review on), both revise, and the merge agent writes one plan.

**Code Review.** Reviewers inspect a branch or pull request on their own, then the consolidation agent removes duplicates, resolves disagreements and ranks the findings.

**Investigation.** Two investigators explore a question across the codebase. They cross-review each other's answers, optionally review their own, and the synthesis step writes the final answer.

**Document.** Pick a document type: RFC, one-pager, ADR, PRD, runbook, postmortem, explainer or custom. Two authors draft, review and revise, and the merge step produces one document. Turn on **Reader review of the final document** to have a separate reader model critique it; you can give the reader an optional persona.

Document authors must use different provider and model pairs, and so must the two Investigation investigators. Feature authors may share a model.

## Options

- **Own-model review:** each author or investigator also reviews its own output.
- **Plans directory:** where plan and draft files are written in the repository (default `plans/`).
- **Compare against branch:** the branch a Code Review inspects. Investigations can optionally compare against a branch too.
- **Run cost limit in USD (optional):** F5 checks the limit before launching each later stage and stops starting new ones once it is reached.

## Review and implement a Feature plan

A Feature run stops after the merge. Read the merged plan on the workflow page. So far only the plan files under the plans directory have been written; no code has changed.

<p align="center">
  <img src="../../assets/screenshots/workflow.png" alt="Finished Feature workflow showing its phase board and the merged plan" width="800" />
</p>

When you are satisfied, click **Implement**. The **Implement workflow plan** dialog asks for:

- the **Implementation model**;
- the **Environment**: **Local** (your checkout) or **New worktree** from a base branch you select;
- the **Access mode**, one of the [runtime modes](../runtime-modes.md);
- **Code review after implementation**, which adds reviewer slots and an apply-reviews pass.

Click **Start implementation** to begin.

## Read results

The phase board at the top of a workflow page shows every stage, its model and its status. Click a stage card to open its thread. Below the board, the page shows the merged plan, the consolidated review, the synthesized answer or the merged document, depending on the type.

<p align="center">
  <img src="../../assets/screenshots/code-review.png" alt="Code Review workflow with two reviewers on different models and the consolidated findings" width="800" />
</p>

**Run inspector** at the bottom of the page shows the template, cost and per-step context.

## When a stage fails

A failed stage shows its error on the board, and the page offers **Retry failed**. On a Code Review, **Retry failed** reruns failed reviewers and **Retry merge** reruns the consolidation.

If F5 could not confirm whether a stage's turn reached the provider, retrying could start the same work twice. F5 then asks first, in a dialog titled **Retry may duplicate a provider turn**. Choose **Retry anyway** only if duplicate work is acceptable; otherwise open the stage thread and check what the provider did.

## Provider limits in slots

Every provider can fill a slot, but capabilities differ. Muse Code rejects Plan mode and read-only turns, so stages that need either cannot run on it; see [Muse Code](../providers/muse.md). Supported permission modes per provider are listed in [runtime modes](../runtime-modes.md).

## Related

- [Threads and workspaces](threads-and-workspaces.md)
- [Worktrees and storage automation](worktrees-and-storage-automation.md)
- [Usage and limits](usage-limits.md) for workflow cost
