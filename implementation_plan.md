# Goal Description

The objective is to overhaul the CopilotQuiz application by adding advanced game types, a new password mechanism, and a premium visual redesign:
1. **Update Host Login**: Set the new host password to `eycopilot2026`.
2. **Homescreen Redesign**: Overhaul the landing page to feature a highly dynamic, "fancy" Copilot-themed design with rich animations (e.g., typing effects, glowing elements, gradient meshes).
3. **New Copilot-Themed Mini-Games**: Expand the game engine beyond standard multiple-choice to include interactive Copilot-themed games, such as "Jumbled Prompt" ordering.

## User Review Required

- **New Game Types**: I have planned the following three mini-games based on your feedback. Please let me know if these sound good:
  - **Classic Quiz**: The standard 4-option Kahoot style.
  - **Jumbled Prompt**: The host displays a scrambled AI prompt (e.g., "Summarize" -> "this document" -> "in 3 bullets"). Players must tap the words on their device in the exact correct order to submit.
  - **Hallucination or Fact? (True/False)**: A rapid-fire binary mode to identify if an AI statement is true or a hallucination.

## Proposed Changes

### Core Logic & Gameplay (app.js)

#### [MODIFY] app.js
- **Login Logic**: Update `setupAdminAuthWorkflow` to check if `pwdInput.value === "eycopilot2026"`.
- **Question Definitions**: Update `copilotPresets` to include a `type` property (`multiple-choice`, `jumbled-prompt`, `true-false`) and new question sets supporting these formats.
- **Host Broadcast Engine**: Modify `executeQuestionBroadcast` and `concludeQuestionEvaluation` to dynamically render the host's screen and chart based on the `q.type`.
- **Player Input Interface**: Update `preparePlayerInputInterface` to render different UI structures based on the `q.type`:
  - **Jumbled Prompt UI**: Render clickable word fragments. When players click a fragment, it moves to their "constructed prompt" area. An automatic submission occurs when all fragments are ordered.
- **Scoring Engine**: Update `evaluateSystemScoringTransactions` to support checking the correct sequence for Jumbled Prompts instead of a single integer index.

### User Interface (index.html)

#### [MODIFY] index.html
- **Homescreen**: Redesign `#view-landing` with new HTML structure to support advanced animations.
- **Host Question View**: Add dynamic containers in `#view-host-question` to display jumbled word boxes instead of the classic 4 shapes when applicable.
- **Player Question View**: Add a new container in `#view-player-question` for the "Jumbled Prompt" interactive interface (a tray of available words and a tray of selected words).

### Styling & Animations (style.css)

#### [MODIFY] style.css
- **Homescreen Animations**: Add new keyframes for pulsing glows, floating particles, and text-typing effects to make it feel extremely premium.
- **Jumbled Prompt UI**: Add styles for draggable/clickable word chips, constructed prompt containers, and interactive hover states.

## Verification Plan

### Automated Tests
- N/A (Frontend application)

### Manual Verification
- **Login**: Verify `eycopilot2026` successfully bypasses authentication.
- **Homescreen**: Inspect the visual aesthetics and CSS animations.
- **Game Engine**: Run a live test session as both host and player to play through a standard question, a True/False question, and a Jumbled Prompt question to ensure the interactive ordering works seamlessly.
