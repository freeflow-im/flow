# Mail: the assistant panel shows the assistant's name and its model

- `[web]` `[desktop]` Mail's assistant panel header shows the person's assistant by name (e.g. "Ada"), not "Assistant"; hovering or focusing it shows a tooltip with the organization's provider and model.
- `[web]` New `assistantModelLabel()` (`@flow/shared/assistant`) and `useAssistantModel()` (suite-bar); Admin's Model card uses the same label.

## Feature

- **Your assistant by name in Mail.** The assistant panel in Mail now shows your assistant's name, such as "Ada". Hover over the name to see which provider and model it runs on.
