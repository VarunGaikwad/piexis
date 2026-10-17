# Local sound effects

The user's local WAV files map to notifications as follows:

| Event | Local file |
| --- | --- |
| Attention | `mixkit-dry-pop-up-notification-alert-2356.wav` |
| Finished | `mixkit-bubble-pop-up-alert-notification-2357.wav` |
| Failure | `mixkit-gaming-lock-2848.wav` |

These files are not bundled or committed. The [Mixkit Sound Effects Free License](https://mixkit.co/license/#sfxFree) permits certain end-product uses but expressly excludes redistribution in a tool or with source files. See the [license text](https://mixkit.co/license/modal/sfxFree/) and [terms](https://mixkit.co/terms/). Their presence here does not relicense them under Piexis's MIT license. Confirm your use complies with the applicable terms.

For an installed package, supply your own PCM WAV files as `attention.wav`, `finished.wav`, and `failure.wav` under `~/.pi/agent/sounds/` (or `$PI_CODING_AGENT_DIR/sounds/`). Personal files take priority over this checkout's local files. No audio is downloaded automatically.

To publish bundled defaults in the future, choose sounds with explicit permission for redistribution in software and source repositories, such as suitable CC0 recordings.
