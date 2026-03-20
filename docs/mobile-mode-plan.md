# Mobile Mode Plan — reef dashboard

## Audit Summary

### Current Architecture
- **HTML**: Single-page app with `#app` → `header` + `#workspace` (3-column flex) + `#panel-area`
- **CSS**: ~320 lines, CSS custom properties for theming, one `@media (max-width: 1100px)` breakpoint that just stacks columns vertically
- **JS**: ~964 lines handling: conversations CRUD, SSE streaming, feed tree rendering, panel discovery, input handling
- **Auth**: Magic link flow — POST `/auth/magic-link` → open URL → session cookie → API proxy

### UI Components
1. **Header**: Logo, tab buttons (feed + dynamic panels), spacer, status dot/label
2. **Conversations sidebar** (15%): header with "new" button, scrollable list grouped by open/closed, each item has title/meta/toggle
3. **Chat/Branch center** (60%): header with label/meta/actions, scrollable messages (user/assistant/tool calls), input bar with textarea + send button
4. **Activity feed** (25%): header with scope label, scrollable tree of feed items with nested children
5. **Panel area**: Absolute overlay toggled by header tabs, discovered dynamically from services
6. **SSE**: fetch-based streaming, auto-reconnect on disconnect with 3s retry

### Problems with Current Mobile Experience
- At <1100px, all 3 columns stack vertically with fixed vh heights — unusable scroll experience
- Conversations list gets 28vh max (too small), feed gets 30vh (awkward)
- No touch target sizing — buttons are 11px font, tiny padding
- Textarea doesn't handle mobile keyboard viewport changes
- Panel overlay starts at `top: 38px` — doesn't account for mobile header
- Tab bar in header gets crowded with dynamic panel tabs
- No way to quickly switch between views
- Feed tree nesting barely visible on narrow screens

## Design: Mobile-First View (320–428px)

### Navigation Pattern: Bottom Tab Bar
A fixed bottom navigation bar with 4 tabs replacing the desktop column layout:
- **💬 Chats** — conversation list
- **📝 Chat** — active conversation (chat view)  
- **📊 Feed** — activity feed
- **⚙ More** — panels dropdown + status

Each tab shows a **full-screen view**. Only one visible at a time.

### Layout Changes
- **Desktop (>768px)**: Keep current 3-column layout unchanged
- **Tablet (769–1100px)**: Keep current stacking but with better sizing  
- **Mobile (≤768px)**: Full-screen single-view with bottom nav

### Mobile View Specifications

#### Bottom Nav Bar
- Fixed to bottom, 56px tall, above mobile keyboard
- 4 equal-width tabs with icons + labels
- Active tab highlighted with accent color
- Badge on Chats tab for unread/active conversations
- Z-index above everything

#### Chats View (Full Screen)
- Header: "conversations" + "new" button (44px touch target)
- Full-height scrollable list
- Conversation items: 48px min height, larger touch targets
- Open/closed groups preserved
- Tap item → switches to Chat view automatically

#### Chat View (Full Screen)  
- Header: back arrow (→ Chats), conversation title (truncated), close/toggle buttons (44px)
- Full-height message scroll area
- Input bar: sticky above bottom nav, textarea + send button
- Mobile keyboard pushes input up via `visualViewport` API
- When no conversation selected: "Select a conversation" prompt + new chat button

#### Feed View (Full Screen)
- Header: "activity" + scope label
- Full-height scrollable feed
- Feed items: slightly larger padding for touch
- Clickable items navigate to Chat view for that conversation
- Tree nesting reduced to single level on mobile (flatten deep nests)

#### Panels/More View
- List of discovered panel tabs as full-width buttons
- Status info at top
- Each panel opens as full-screen overlay with back button

### Touch & Input
- All interactive elements: minimum 44×44px touch target
- Send button: 44×44px
- Textarea: full-width, auto-grows, 44px min height
- Use `visualViewport` API to handle iOS/Android keyboard resize
- Prevent body scroll when keyboard is open

### SSE/Reconnection on Mobile
- Existing reconnect logic (3s retry) works for backgrounding
- Add `visibilitychange` listener to force reconnect when app returns to foreground
- Add `online` event listener for network recovery

### Magic Link Auth on Mobile
- Login page already works on mobile (simple HTML)
- Magic link opens in mobile browser → sets cookie → redirects to `/ui/`
- No changes needed, but ensure login page is responsive

### Implementation Strategy
1. Add `<meta name="viewport">` — already present ✓
2. Add mobile detection CSS media query at `≤768px`
3. Add bottom nav HTML
4. Add mobile CSS for full-screen views + bottom nav
5. Add JS for view switching, keyboard handling, visibility reconnect
6. Preserve all desktop behavior — mobile is additive only

## File Changes

### `static/index.html`
- Add bottom nav bar `<nav id="mobile-nav">` before closing `</div>` of `#app`

### `static/style.css`  
- Add `@media (max-width: 768px)` block with all mobile styles
- Bottom nav styles
- Full-screen view overrides
- Touch target sizing
- Input/keyboard handling

### `static/app.js`
- Add mobile view switching functions
- Add `visualViewport` keyboard handler
- Add `visibilitychange` + `online` reconnect listeners
- Hook conversation selection to auto-switch to chat view on mobile
