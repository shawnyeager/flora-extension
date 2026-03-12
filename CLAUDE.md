# Flora

Decentralized screen recording Chrome extension — Loom on Nostr + Blossom.

## Tech Stack

- **Framework**: WXT (Web eXtension Toolkit), TypeScript, Chrome MV3
- **Key deps**: `blossom-client-sdk`, `nostr-tools`, `mediabunny`
- **Architecture**: 4 contexts — popup, service worker (background), offscreen document, content script
- **Build**: `npm run build` (Vite via WXT)

## Design Context

### Users

Content creators and Nostr power users who want fast, frictionless async video sharing on decentralized infrastructure. They're recording tutorials, bug reports, demos, and quick messages. Context: mid-workflow, impatient, want to record and share in seconds.

### Brand Personality

**Playful, warm, approachable.** Flora should feel like a friendly tool that's delightful to use — not intimidating, not sterile, not "serious software." It should bring a smile. The flower logo is central to the identity: organic, colorful, alive.

### Aesthetic Direction

**References**: Loom (effortless record-and-share UX), Raycast (speed, minimal chrome, utility-first beauty).

**Anti-references**: Generic SaaS (no blue gradients, no startup templates), Crypto/Web3 kitsch (no neon-on-dark, no blockchain aesthetic), Enterprise software (no data tables, no sidebar navs), Skeuomorphic/retro.

**Theme**: Dark mode only. The dark background makes the logo's colors sing.

**Color palette**: Derived from the logo — overlapping translucent petals of pink, violet, and cyan around a dark lens center.

- **Primary accent**: Flora berry (`oklch(62% 0.15 340)` / ~#c96b9c) — the petal overlap between pink and violet, used for primary actions and recording states
- **Secondary accent**: Flora violet (`oklch(62% 0.19 295)` / ~#9b6ec7) — the deepest petal overlap, used for selection, focus, and interactive highlights
- **Tertiary accent**: Flora cyan (`oklch(78% 0.12 210)` / ~#7ec8e3) — the coolest petal, used for links, informational states, and secondary buttons
- **Success**: Soft green (`oklch(76% 0.15 155)` / ~#4ade80)
- **Warning**: Warm amber (`oklch(80% 0.14 80)` / ~#fbbf24)
- **Danger/Error**: Keep the existing red (`#ef4444`) — universally understood for destructive actions
- **Backgrounds**: `#111114` base, white-alpha layers for elevation. Tint neutrals slightly toward violet (never pure gray).
- **Text**: `#f0f0f2` primary, `#9ca3af` secondary, `#6b7280` muted

**Typography**: System font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`). Performance matters more than a custom typeface in an extension. Use weight and size variation for hierarchy, not font changes.

### Design Principles

1. **Speed is the feature.** Every interaction should feel instant. Record, share, done. Minimize clicks, eliminate waiting. If a user has to think about the tool, it's too slow.

2. **Progressive disclosure.** Show the minimum needed, reveal more on interaction. Hover for actions, click for details. Never overwhelm with a wall of buttons.

3. **The flower blooms.** The logo's overlapping-petal colors are the design DNA. Use them with purpose — pink for action, violet for focus, cyan for information. Let them appear as accents against the dark ground, like the flower emerging from shadow.

4. **Warmth over precision.** Prefer organic curves, gentle easing, and forgiving spacing over pixel-perfect rigidity. The product should feel handmade, not machine-generated. Avoid perfectly even grids, identical card layouts, and mechanical repetition.

5. **Respect the craft.** WCAG AA contrast, keyboard navigation, `aria-label` on icon buttons, `prefers-reduced-motion` support. Accessibility isn't optional — it's part of the warmth.

### CSS Token Prefix

All custom properties use `--fl-` prefix (FL = Flora).

### Spacing Scale

```
--fl-space-xs: 4px
--fl-space-sm: 8px
--fl-space-md: 16px
--fl-space-lg: 24px
--fl-space-xl: 32px
```

### Border Radius

```
--fl-radius-sm: 6px
--fl-radius-md: 10px
--fl-radius-lg: 16px
--fl-radius-pill: 9999px
```

### Animation

- Easing: `cubic-bezier(0.16, 1, 0.3, 1)` — smooth deceleration, not bouncy
- Fast transitions: 0.15s (hover, color changes)
- Normal transitions: 0.25s (panels, modals)
- Entry animations: fade + translateY(8px), staggered per item
- Always respect `prefers-reduced-motion: reduce`
