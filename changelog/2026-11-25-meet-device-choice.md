# Meet: choose camera, microphone and speaker before and during a meeting

- `[web]` `[desktop]` Check screen gets Camera / Microphone / Speaker pickers, a mic level meter and Test speaker; the room gets an "Audio and video" panel to switch them live (Taskboard task 48).
- `[web]` `[desktop]` Choices are remembered per browser (huddles use them too) and follow devices being plugged in or out; the Speaker picker is hidden where the browser has no `setSinkId`.

## Feature

- **Pick your camera, microphone and speaker.** Before joining a meeting, choose which camera, microphone and speaker to use, watch your mic level and play a test sound. In the meeting, the new Audio and video button switches them without leaving. Your choices are remembered, and unplugging a headset falls back to the default until you plug it back in. Browsers that cannot pick a speaker (such as Safari) play sound on the system speaker.
