# Nook: name, character and artwork

Nook is built from Coucou's code (MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE)).
None of Coucou's reserved assets are in this repository: its name, the Mochi
character, its app and menu bar icons, its sounds and its images and videos
belong to Louis Raillé and are not used here.

What Nook ships instead is its own:

- **Gullu**, Nook's buddy, drawn in code (`windows/src/bot/engine.ts`) from
  `design/prototype/nook-buddy.html`, and the app icons drawn from it by
  `windows/scripts/gen-icons.mjs`;
- **the sounds** in `windows/sounds/`, synthesized from plain sine and triangle
  tones by `windows/scripts/make-sounds.mjs`; nothing in them is sampled;
- **the interface icons**, which come from Lucide and Simple Icons under their
  own licences (see [NOTICE](NOTICE)).

Gullu, the icons and the sounds are original to Nook and are covered by the
same MIT licence as the code. The name "Nook" and the look of Gullu are the
project's; if you fork Nook to ship your own app, give it your own name and icon.

Nook is not affiliated with or endorsed by Coucou's author or by Anthropic.
