# hagah_targets: Target map for the Hagah Bible app (React Native/Expo, app.kifactory.hagah, TestFlight build 1.0.0 (5)): every scene step of v8.5-roteiro-video.md resolved to iOS accessibility labels, code locations and a targeting strategy

## SUMMARY
I read the roteiro and the mobile source (apps/mobile/src at dff2e21), resolved every i18n key to its English string, and checked how each element reaches iOS accessibility. The app has 0 testIDs, so every target has to be matched by its English label. Most controls are accessible Pressables. Their label is either explicit or built from the child Text, and Pressable is accessible by default, so anything nested inside a Pressable disappears from the tree. That hides the Plan row's download icon and the Downloads row's Pin/Delete buttons, which then need coordinate taps (or the day screen's own "Download" button). Verses are one accessible element per verse side, labelled with the whole verse text. The verse number is a separate button labelled "Verse N". Single words are never separate elements, even in the Word lens, so tapping "shepherd" needs OCR on a screenshot. The roteiro uses several strings from the PWA that the native app does not have. "· Passage actions", "HIGHLIGHT VERSE", "PERSONAL NOTE" and "Save note" come from src/components/VerseActionSheet.tsx. The app instead uses a selection bar (Highlight → Gold/Green/Blue/Lilac, Note → a note screen with "Save"). In Now Playing the row is "Pause", not "Pause between repeats". The playlist button is "Play", not "▶ Play". The header chip is "Parallel", not "Parallel reading". The mini-player shows "Day N" over "Bible in a Year · Day N"; "Day N · … · 4Ventos" exists only on the lock screen. There is no sleep-timer chip in the mini-player. Several things happen on their own and can derail a take. Any drag stops auto-follow. A horizontal drag over 20 pt changes chapter. A lens popover closes on every auto-scroll, and the verse list is hidden from accessibility while it is open. Highlights are drawn only in the Reading lens. Psalm 23 can end and auto-advance to Psalm 24 before scene 4. Scene 4's "End of chapter" sleep timer will pause playback during scene 5. A lot of state persists between takes and needs a reset step: the hagah:prefs jar (last position, parallel version, repeat, echo, speed, presets), the local journal, downloads, a stored in-app language, and the Keychain session, which survives a reinstall. Scene 7 also leaves the user signed in again with a live Apple authorization. Store builds compile out the dev tools (EXPO_PUBLIC_DEV_TOOLS=0, routes behind Stack.Protected, /dev links sent to /bible), so nothing from development can show on screen. hagah:// and hagah.kifactory.app links can set up position, parallel and lens before a take. They cannot turn parallel off, and opening them from the runner is unverified.

## RISKS
- [high] The roteiro's on-screen labels do not match the native app in several places, so a choreography written from the script will fail to find its targets.
  why: Scene 6 uses PWA strings ("· Passage actions", "HIGHLIGHT VERSE", "PERSONAL NOTE", "Save note"). Scene 8 uses "▶ Play" and expects "Day N · Bible in a Year · 4Ventos" in the mini-player. Scene 4 expects "Pause between repeats" and a timer chip in the player. Scene 5 expects a "Parallel reading" chip and a per-verse Focus action. Scene 7 quotes a description missing its second sentence. Scene 9 expects "{size} on this device" on the Downloads screen. The real labels are in the findings.
  spike: On the TestFlight build in English, run the runner's snapshot on each screen the script visits (reader, both pickers, Now Playing at full detent, selection bar, note modal, Journal signed out and signed in, Settings, Downloads, About, Plan list and day, playlist detail). Diff the result against this map.
  success: Every choreography target resolves to exactly 1 hittable element (or one OCR box) on its screen. Zero script strings remain that the app does not show.
  planB: Amend v8.5-roteiro-video.md, and the narration where it quotes UI text, to the native labels: Highlight → Gold, Note → Save, Play, Pause, Parallel, the header Focus chip, the Settings Downloads row.
- [high] Labels built from children may not equal the visible text, and the XCUITest element types for RN roles are unknown.
  why: Many buttons have no explicit accessibilityLabel (chapter title, version chip, Parallel chip, Focus visible text, CardButton, LinkRow-less buttons, Plan main button, Playlist Play), so RN builds the label recursively from the subviews. expo-symbols SymbolView image views might add an SF Symbol name, and word-mode rows may add extra spaces. The roles tab, tablist, toolbar, link, adjustable and radio map to traits that XCUITest may report as Button, Other or Link.
  spike: Dump label, type, traits, frame and isHittable for 30 representative targets on device.
  success: At least 95% of targets match this map's label with an exact or BEGINSWITH predicate. Every exception is recorded in a target catalog with its real label and type.
  planB: Match on label (CONTAINS/BEGINSWITH) regardless of element type. Scope by container (toolbar "Actions for …", tablist "Reading lens") or by frame. Fall back to OCR of the visible text.
- [high] Tapping a word ("shepherd") depends on OCR.
  why: Words are never accessibility elements: the verse side Pressable is accessible and swallows its child Texts. A tap waits 300 ms to rule out a double tap; a second tap inside that window plays audio from the verse instead. Any auto-scroll or drag closes the popover, and while the popover is open the verse list is hidden from accessibility.
  spike: With Psalm 23 NIV in the Word lens, paused, and parallel NVI on: screenshot, run Vision text recognition (accurate level) inside the frame of the verse element whose label contains "shepherd", tap the centre of the box converted from @3x pixels to points, and wait for the element "shepherd, Psalms 23:1".
  success: The popover opens on the correct word in at least 19 of 20 runs. OCR plus tap takes under 700 ms. No unintended double tap occurs.
  planB: Estimate the word's position from the verse element frame (the first line, a known glyph offset for "The LORD is my "). Or change the narration to a word at the start of a line. Always pause playback before tapping so following never closes the popover.
- [high] Playback runs off the end of Psalm 23 in the middle of a scene.
  why: With Repeat Off the player advances to Psalm 24 and the reader page follows it (followAdvance). Scenes 2–3 play for about 70 s or more, and Psalm 23 NIV is short. After scene 4, the Sleep preset loops the whole book and the "End of chapter" timer fades and pauses at the end of the current recording, probably during scene 5's echo demo.
  spike: Read the Psalm 23 NIV duration from the Now Playing clock (the −m:ss figure) or the alignment JSON. Lay the take's timeline against it, including the echo, which roughly doubles each verse.
  success: A full dry run never shows Psalm 24 and never pauses unexpectedly. The timeline marks every planned pause and resume.
  planB: Pause at the end of scene 2 and resume in scene 3. Or set Repeat "Chapter" before playing. Or set the sleep timer back to "Off" after showing it in scene 4. Or use a longer demo chapter.
- [high] State from a previous take changes what the next take shows.
  why: The highlight toggles off if the verse is already Gold. The note editor opens pre-filled. Parallel, echo, repeat and preset persist in hagah:prefs. The last position may already be Psalm 23, which makes the picker step a no-op. The plan day may already be downloaded, so there is no Download button. A stored in-app language overrides English. Scene 7 ends signed in, with an empty server account and an active Apple authorization.
  spike: Write a reset choreography (deep links plus taps) followed by a verification block of assertions, and run it after a full take.
  success: All assertions pass in under 3 minutes: Journal signed out with "0 entries"; header chip "Parallel" not selected; Now Playing has Repeat "Off", Bilingual echo "Off", Sleep timer "Off" and "1×" selected; the start page is Psalm 1 NIV; the plan day shows "Download"; Downloads lists Psalm 23 NIV with audio; Settings › Interface language shows "English" checked; the app is terminated.
  planB: Delete and reinstall the TestFlight app (sign out first, because the Keychain session survives), then redo the prep: open Psalm 23 NIV and NVI online, turn on Download while listening and play Psalm 23 once, create the playlist.
- [medium] The Sign in with Apple sheet and the account label differ from take to take.
  why: Apple sends fullName only on the first authorization, after which the card reads "Signed in with Apple" with no name. Scene 7's final re-sign-in leaves an authorization in place, so the next take's "sign-up" shows the returning-user sheet and may show no name. That undercuts the "account is created here" claim.
  spike: At the end of a take, delete the account again (with revocation), then start a fresh take and record the sheet's variant and the card label.
  success: The first-time sheet with its name-sharing options appears, and the card shows "Signed in with Apple · <name>".
  planB: As a human prep step, remove Hagah in iOS Settings › Apple Account › Sign-In & Security › Sign in with Apple. Or use a fresh test Apple ID for each final take.
- [medium] Controls nested inside an accessible row are not in the tree.
  why: RN Pressables are accessible by default, so the Plan day row's download icon and the Downloads row's Pin/Delete icons are probably hidden from XCUITest.
  spike: Query for "Download" on the Plan list and for "Delete" on the Downloads list, then try coordinate taps at (row.maxX−30, row.midY).
  success: Either the query finds the button, or the coordinate tap triggers the action in 10 of 10 runs.
  planB: Use the day screen's "Download" and "Remove from device" buttons. For resets, use the day screen or "Free up space".
- [medium] Several identical labels are visible at once, made worse by modals stacked over the tabs.
  why: "Play"/"Pause" (mini-player, Now Playing, Focus footer, playlist, plan day), "Close", "Off" (three in Now Playing), "Journal"/"Playlists"/"Plan" (tab vs header), and "Repeat". The Now Playing formSheet and the Focus transparentModal may leave the views behind them in the tree.
  spike: Snapshot with the Now Playing sheet at both detents and with Focus open. Count the matches for "Play", "Pause" and "Close", with their isHittable values.
  success: A documented rule (scope container, frame band, hint, ordinal) picks the intended element in 10 of 10 runs per case.
  planB: Act through coordinates computed from a uniquely labelled anchor in the same component (e.g. "Back 15 seconds" → the next button to the right).
- [medium] Gestures cause unintended navigation or don't register.
  why: Reader: more than 20 pt sideways commits a chapter swipe. Focus needs a 96 pt swipe and a 140 pt pull from scroll offset 0. Pull-to-refresh needs a slow drag. The Now Playing sheet needs an expand or scroll to reach Repeat and the Sleep timer.
  spike: Run each gesture 10 times with XCUICoordinate press(forDuration:thenDragTo:withVelocity:thenHoldForDuration:) using the thresholds in the findings.
  success: 10 of 10 for each gesture, and 0 chapter changes during vertical scrolls.
  planB: Use the button equivalents: Focus "Close", the "Sync" button for refresh, scroll-to-element instead of a free drag. Keep reader scrolls strictly vertical with a small dx.
- [medium] Scene 9's "tap play" plays the plan episode or playlist instead of Psalm 23, offline.
  why: The reader hands its recording to the player only when the page is first opened. After scene 8 the mini-player still holds the episode or playlist, which may not be downloaded.
  spike: After scene 8, turn airplane mode on, go to the Bible tab and double-tap verse 1 (or verse number → "Listen").
  success: The mini-player title is "Psalms 23" and audio plays within 1 s with no network.
  planB: Open the chapter again through the picker (another chapter, then back) so it is a new page, or stop playback before scene 9.
- [medium] The reader header (title, version, Focus, Parallel) is out of view after auto-follow.
  why: The header is the list's ListHeaderComponent, so it scrolls away. Only the lens bar is pinned.
  spike: From the middle of a chapter, try a status-bar tap (coordinate at y≈10) and a downward swipe, then check that the "Focus" button is hittable.
  success: The header is hittable within 1.5 s in 10 of 10 runs.
  planB: Pause and drag down repeatedly until "Focus" is hittable, or open Focus and Parallel before playback moves on.
- [low] Opening deep links from the runner may show a confirmation prompt or not be honoured.
  why: Custom schemes opened through system APIs can prompt "Open in “Hagah Bible”?". Universal links depend on the AASA file.
  spike: Call XCUIApplication(bundleIdentifier:"app.kifactory.hagah").open(URL(string:"hagah://bible/ENGNIV/PSA/1")!) and XCUIDevice.shared.system.open(...) from the runner.
  success: The app comes to the foreground on Psalm 1 NIV within 3 s with no prompt.
  planB: Navigate through the UI (the picker), or accept the prompt with a system-alert handler. Use deep links only during preparation, never during the take.
- [medium] Apple sheets and alerts are interleaved in the delete flow.
  why: Confirm alert → Apple re-auth sheet (system process, human) → result alert with RN's default "OK". If the sheet is cancelled, a third alert appears. Detection has to cover both app alerts and system UI.
  spike: Run delete-account once in rehearsal and record the sequence and the time each step appears.
  success: Each alert or sheet is detected within 1 s of appearing, and the runner resumes on its own after the human completes Face ID.
  planB: Treat the whole delete sequence as one human checkpoint whose resume condition is the "Account deleted" alert.
- [low] The interface language may not be English even on an English iPhone.
  why: A choice stored in Settings › Interface language (KV hagah:app:locale) overrides the device language. Book names also follow the version's language, so NVI pages show "Salmos".
  spike: Snapshot Settings › Appearance and check the radio "English" (checked) or that no stored choice exists.
  success: The tab labels read "Bible/Plan/Playlists/Journal" and the reader title reads "Psalms 1".
  planB: Tap the "English" radio in Settings during prep.

## RECOMMENDATIONS
- Build a versioned target catalog (YAML or JSON) from this map: for each target, its screen, primary predicate (exact or BEGINSWITH label plus optional type and scope container), fallback (OCR text or coordinate relative to an anchor element) and post-condition. Query by label only, since the app has 0 testIDs, and keep the catalog English-only.
- Fix the roteiro before writing choreography: replace the PWA strings with the native labels (Verse N → selection bar → Highlight → Gold → Back to actions → Note → Save; Pause row; Play; the Parallel chip; the header Focus chip; the Settings "Downloads, X on this device" row; the mini-player "Day N"/"Bible in a Year · Day N"; Book behind ⋯; no timer chip in the mini-player).
- Begin every take with a reset-and-verify choreography, then terminate the app so scene 1 shows the splash. Leave the last position at Psalm 1 NIV, not Psalm 23. End every take with a cleanup: delete the account with Apple revocation, then sign out, so the next take gets Apple's first-time sheet.
- Treat as human checkpoints: the Sign in with Apple sheet (twice, plus the re-auth during deletion), lock and unlock, airplane mode on and off, and Control Center. Treat the RN Alerts ("Delete account?", "Account deleted", "Delete without confirming with Apple?") as in-app alerts reachable through app.alerts.
- Use OCR only for the word tap in scene 5 and as a fallback. Pause playback before any lens popover interaction, and close the popover before querying verses.
- Keep all reader drags vertical. Use velocity-controlled coordinate drags for the Focus swipe (≥96 pt) and pull (≥140 pt from scroll top) and for pull-to-refresh, each with a button fallback (Close, Sync).
- Plan the audio timeline from the measured Psalm 23 NIV duration. Decide on explicit pause and resume points, and when to turn the sleep timer back off, so no auto-advance or timer pause lands mid-scene.
- In scene 9, start playback with a double-tap on verse 1 (or verse number → Listen), not the mini-player. Pre-download Psalm 23 NIV audio (Download while listening ON plus one full play) and open Psalm 23 NVI once online.
- Use the Plan day screen's "Download" button rather than the nested icon in the list row.
- Use deep links (hagah://bible/ENGNIV/PSA/1, hagah://settings/downloads, etc.) only for preparation, after the open-URL spike passes. Remember that a link cannot turn parallel reading off.

## FINDINGS
### F1 [verified] Scene 1 step 1: Home-screen icon to launch the app
The icon label is "Hagah Bible" (CFBundleDisplayName), not "Hagah" as the script says. Strategy: system — query the Springboard (XCUIApplication(bundleIdentifier: "com.apple.springboard").icons["Hagah Bible"]). Caveat: the splash only plays on a cold launch, so the take needs XCUIApplication(bundleIdentifier: "app.kifactory.hagah").terminate() first. A backgrounded app resumes with no splash and keeps its session state (lens, Journal filter, player, sleep timer).
SRC: apps/mobile/ios/HagahBible/Info.plist:11-12; apps/mobile/src/app/_layout.tsx:50,62,100-111

### F2 [verified] Scene 1 step 2: Reader opens straight on the last chapter read (or Psalm 1)
Route / → /bible (app/index.tsx:9). The Bible tab shows a spinner labelled "Opening your reading…" while prefs load, then redirects to resolveStartChapter. That is the stored position in the KV key hagah:prefs (SQLite <Documents>/SQLite/hagah.db), or on a first boot Psalm 1 in the language default (NIV, ENGNIV, for an English phone). The position is written by readerPrefs.setPosition once a page's content loads. Ready signal: an accessible button whose label begins with "Psalms 1" (the chapter-title button). Strategy: a11y wait, BEGINSWITH. Caveat: book names follow the version's language, not the UI (an NVI position shows "Salmos"). Caveat: there is no login, onboarding or paywall in the code path.
SRC: apps/mobile/src/app/(tabs)/bible/index.tsx:38-73; apps/mobile/src/state/readerPrefs.ts:41,285-307; apps/mobile/src/app/(tabs)/bible/[abbr]/[book]/[chapter].tsx:278-289; packages/core/src/reader/prefs.ts:109-120

### F3 [verified] Scene 2 step 1: Chapter header → reference picker
A Pressable with role button and no explicit label, so the label comes from its child Text, e.g. "Psalms 1" (reader.chapterTitle "{book} {chapter}"). The hint is "Choose book and chapter". The NIV version chip next to it (label "NIV", hint "Choose the version") opens the same picker. Strategy: a11y BEGINSWITH "Psalms" plus type Button. The derived label may also pick up the chevron SF Symbol (see risks). Caveat: the header is the list's ListHeaderComponent and scrolls away with the verses, so return to the top before using it.
SRC: apps/mobile/src/components/ChapterHeader.tsx:104-135; packages/core/src/i18n/messages/en/app.ts:31-36

### F4 [verified] Scene 2 step 2: Reference picker — version chip (only if the current version is not NIV)
Modal pageSheet with header "Choose a reading" and a "Close" button. Version chips have accessibilityLabel={version.name}, the full name from the server list, not the visible "NIV". The fixture gives "Holy Bible, New International Version®"; the production name is unverified. Strategy: a11y CONTAINS "New International Version", or OCR on "NIV". Caveat: tapping a version calls onPick, which closes the picker and navigates at once, so changing version and chapter takes two picker passes. Prep should leave the last position in NIV so the take needs one.
SRC: apps/mobile/src/components/ReferencePicker.tsx:47-108; apps/mobile/src/content/__fixtures__/origin.ts:53-70

### F5 [verified] Scene 2 step 3: Reference picker — book row "Psalms" then chapter cell "23"
Book rows are buttons labelled with the book name ("Psalms") and carry accessibilityState expanded. Chapter cells are buttons labelled with their number ("23") and carry selected state. When the picker opens it expands the current book (onShow → setOpenBook(current.bookId)). It is a plain ScrollView of 66 books, so every row is in the tree but Psalms is off-screen: scroll first, or rely on XCUITest's scroll-to-hittable. Strategy: a11y ("Psalms", then "23" scoped below the Psalms row). Caveat: if the stored position is already Psalm 23 NIV, onPick returns early (sameChapter) and nothing changes on screen. Prep must leave a different chapter.
SRC: apps/mobile/src/components/ReferencePicker.tsx:44,52,112-163; apps/mobile/src/app/(tabs)/bible/[abbr]/[book]/[chapter].tsx:495-511

### F6 [likely] Scene 2 step 4: Mini-player play button
Pressable with role button and label "Play" ("Pause" while playing). The title area is a separate button labelled "Open Now Playing: {title}, {subtitle}", e.g. "Open Now Playing: Psalms 23, NIV". On iOS 26 it sits in NativeTabs.BottomAccessory, which renders two copies (regular and inline). react-native-screens sets the inactive copy hidden=YES, so only one should be exposed. Strategy: a11y-ambiguous. "Play"/"Pause" also label the Now Playing transport, the Focus footer, the playlist detail and the plan day button. Take the hittable match whose frame is just above the tab bar. Caveat: opening a new chapter page loads that page's recording into the player, so after the picker the mini-player holds Psalm 23.
SRC: apps/mobile/src/components/MiniPlayer.tsx:83-119; apps/mobile/src/app/(tabs)/_layout.tsx:36-53,82-85; apps/mobile/src/components/miniPlayerHost.ts:61-66; https://github.com/software-mansion/react-native-screens/blob/main/ios/tabs/bottom-accessory/RNSTabsBottomAccessoryHelper.mm#L70-L90

### F7 [verified] Scene 2 step 5: Verse karaoke (highlighted verse and gold word)
Visual only, with nothing to tap. Each row has a verse-number button labelled "Verse N" and a body Pressable with no role. In plain reading the body's label is the verse text (sideLabel returns undefined, so RN builds it from the child Text). Hint: "Double-tap to listen from this verse". The karaoke word is a nested Text run with a background colour (palette.karaoke). Neither the active verse nor the spoken word is exposed in accessibility. Strategy: verify by screenshot or pixel colour, not a11y. Caveat: FlashList v2 virtualises rows; Psalm 23 is short, but in long chapters off-screen verses are not in the tree, and recycled rows mean an element must be re-queried before every action.
SRC: apps/mobile/src/components/VerseList.tsx:843-866,895-962,1042-1068,1121-1134,1196-1228

### F8 [verified] Scene 2 step 6: "Scroll lightly to show the list follows by itself"
Gesture: coordinate, a vertical drag on the list. Any user drag (onScrollBeginDrag) sets following=false, so the list stops tracking. A floating button appears, labelled "Follow the narration" (from its Text), hint "Goes back to following the verse being read". Tap it (a11y) to show the list re-centring on the verse being read. Caveat: the chapter-swipe pan claims the touch once it moves more than 20 pt sideways before 12 pt vertically, and it commits on release past min(96 pt, 25% of width), or on a fling of 32 pt at 700 pt/s. The drag must stay vertical (|dx| < |dy|/1.5) or the chapter changes. Psalm 23 (6 verses) may barely scroll.
SRC: apps/mobile/src/components/VerseList.tsx:400-426,861-889; apps/mobile/src/components/verseListLogic.ts:521-536,578-580,628-662

### F9 [verified] Scene 2 step 7: Open Now Playing from the mini-player
Button labelled "Open Now Playing: {title}, {subtitle}". The subtitle gains the verse while playing ("NIV · v. 3"), so the label keeps changing. Strategy: a11y BEGINSWITH "Open Now Playing". It opens an iOS formSheet with detents [0.5, 1] that starts at half height, with a grabber; on iOS 26 the background is transparent Liquid Glass.
SRC: apps/mobile/src/components/MiniPlayer.tsx:83-101; apps/mobile/src/player/bridge.ts:356-388; apps/mobile/src/components/nowPlayingPresentation.ts:21-38

### F10 [verified] Scene 2 step 8: Now Playing transport
Buttons with explicit labels: "Previous verse", "Back 15 seconds", "Play"/"Pause", "Forward 15 seconds", "Next verse". The close X is labelled "Close". Strategy: a11y ("Play"/"Pause" and "Close" are ambiguous app-wide; scope to the sheet). Caveat: the sheet is presented over the reader and the mini-player. Whether XCUITest still exposes the views behind it is unverified (see risks).
SRC: apps/mobile/src/app/now-playing.tsx:149-165,297-381; packages/core/src/i18n/messages/en/app.ts:285-288

### F11 [verified] Scene 3 step 1: Lock the screen with the side button
Strategy: system (hardware button; XCUIDevice has no public lock API) or a human checkpoint. The app only matters for what shows next: the audio background mode is declared (UIBackgroundModes audio).
SRC: apps/mobile/ios/HagahBible/Info.plist:60-63

### F12 [verified] Scene 3 step 2: Lock-screen Now Playing controls
Strategy: system. Metadata the app sets: title = chapter title ("Psalms 23"); album = version.name (full name), or "Echo · NIV ⇄ NVI" when the echo runs; artist "Hagah Bible". For a plan day: title "Day N · {readings}", album "Bible in a Year · 4Ventos". Remote next/previous are verse steps. Unlocking is a human checkpoint. Detect the return by the app being foreground and the mini-player showing "Pause".
SRC: apps/mobile/src/player/bridge.ts:1341-1382; apps/mobile/src/ports/audioTransport.ts:90-108; apps/mobile/src/player/episode.ts:308-320

### F13 [verified] Scene 4 step 1: Now Playing → "Repeat" section and modes Off/Passage/Verse/Chapter/Book
"Repeat" is a plain Text title, not a button, so there is nothing to "open". It sits below the 0.5 detent: scroll the sheet's ScrollView or drag the grabber up (coordinate). Mode chips are buttons labelled "Off", "Passage", "Verse", "Chapter" and "⋯" (hint "More units"). "Book" only appears after tapping "⋯", or inline once Book is selected (for example after the Sleep preset). "Passage" is disabled without a selection, with the note "Select verses in the text to repeat a passage". Strategy: a11y-ambiguous — "Off" appears three times in the sheet (Repeat, Bilingual echo, Sleep timer). Take the first "Off" below the "Repeat" text, by frame order.
SRC: apps/mobile/src/components/RepeatControls.tsx:122-174,341-383; apps/mobile/src/components/repeatControlsLogic.ts:45-48,225-232; packages/core/src/i18n/messages/en/shared.ts:111-125

### F14 [verified] Scene 4 step 2: Times row with ∞
The row label is the Text "Times". The chips are buttons "∞", "2×", "3×", "5×" (COUNT_OPTIONS [null,2,3,5]). They are disabled while the mode is Off or Book (Book has no count). Strategy: a11y by label; "∞" is unique. Caveat: under Book or Off the chips show with disabled state, which reads fine on video.
SRC: apps/mobile/src/components/RepeatControls.tsx:176-205; apps/mobile/src/components/repeatControlsLogic.ts:46,239-244; apps/mobile/src/i18n/labels.ts:131-134

### F15 [verified] Scene 4 step 3: "Pause between repeats" row
In Now Playing the row label is "Pause" (reader.repeat.gap), not "Pause between repeats". That string only appears in Settings › Presets (PresetEditor). The chips are "0", "3 s" and "same as the verse"/"same as the chapter"/"same as the passage" ("same as the reading" while the echo runs). Strategy: a11y. Caveat: "Pause" is also the transport button's label while playing; the row label is a StaticText, so query buttons only.
SRC: apps/mobile/src/components/RepeatControls.tsx:207-218; apps/mobile/src/components/settings/PresetEditor.tsx:164; packages/core/src/i18n/messages/en/app.ts:78; packages/core/src/i18n/messages/en/shared.ts:134-140

### F16 [verified] Scene 4 step 4: Speed row
Row label "Speed". Chips "0.7×", "0.85×", "1×", "1.2×". Long-press toggles the fine stepper (buttons "Slower"/"Faster"). Strategy: a11y.
SRC: apps/mobile/src/components/RepeatControls.tsx:241-274; apps/mobile/src/components/repeatControlsLogic.ts:48,256-261

### F17 [verified] Scene 4 step 5: Preset "Sleep" (and "Study")
Buttons with labels "Sleep: Book · ∞ · 1×" and "Study: Verse · 3× · same as the verse · 0.85×" (name plus presetSummary) and selected state. Strategy: a11y BEGINSWITH "Sleep:". Effect: repeat book ∞, speed 1×; the mini-player chip becomes "book" (a11y "Repeating book"). Caveat: a long press opens an Alert to edit the preset ("{name} preset" / "Save the current settings" / "Restore the default"), so the tap must be short. Presets are persisted in hagah:prefs.
SRC: apps/mobile/src/components/RepeatControls.tsx:90-116,276-313; apps/mobile/src/components/repeatControlsLogic.ts:159-168; packages/core/src/reader/prefs.ts:104-107; apps/mobile/src/components/miniPlayerChip.ts:98-146

### F18 [verified] Scene 4 step 6: Sleep timer → "End of chapter"
Row label "Sleep timer". Chips "Off", "15 min", "30 min", "45 min", "60 min", "End of chapter". The status Text then reads "Pauses at the end of the chapter" (or "Pauses in m:ss", "Pausing…"). Strategy: a11y; "End of chapter" is unique. Caveat: the mini-player has no timer chip, contrary to the script; only the status line in Now Playing shows it. The timer lives in memory only (it resets on cold start) and fades and pauses at the end of the current recording, i.e. during scene 5.
SRC: apps/mobile/src/components/SleepTimer.tsx:19-71; apps/mobile/src/components/sleepTimerLogic.ts:29-55; apps/mobile/src/player/sleepTimer.ts:1-57

### F19 [verified] Scene 5 step 1: Parallel-reading chip in the chapter header
Button, label from Text: "Parallel" when off, the mirror label ("NVI") when on. Hint "Choose the parallel version or turn it off"; selected state. The script's "Parallel reading" is the picker's title. Strategy: a11y (CONTAINS "Parallel" in case an SF Symbol name joins the label). Caveat: it lives in the header, which scrolls away; scroll to the top first. Once on, the header also shows "Narrate in NVI" (do not tap it: it swaps the narrated version) and a Visible/Blurred/Hidden selector.
SRC: apps/mobile/src/components/ChapterHeader.tsx:158-233; packages/core/src/i18n/messages/en/app.ts:124-126,208

### F20 [verified] Scene 5 step 2: Mirror picker → NVI
Modal pageSheet titled "Parallel reading", body "The second version appears under each verse (beside it on wide screens)." Version chips: accessibilityLabel={version.name}, which the fixture gives as "Bíblia Sagrada, Nova Versão Internacional®"; the visible text is "NVI". "Turn off" button (hint "Goes back to reading a single version"). Strategy: a11y CONTAINS "Nova Versão Internacional", or OCR on "NVI". Caveat: the choice persists in hagah:prefs (parallelAbbr), so it must be reset after the take with "Turn off".
SRC: apps/mobile/src/components/MirrorPicker.tsx:40-122; apps/mobile/src/app/(tabs)/bible/[abbr]/[book]/[chapter].tsx:514-526

### F21 [verified] Scene 5 step 3: Lens bar Reading / Passages / Word
Pressables with role tab and selected state, labelled from their Text: "Reading", "Passages", "Word". Hints: "Tapping a word lights up its correspondence for 2 seconds" / "Tapping a word shows the matching passage" / "Tapping a word opens the dictionary". The tablist container is labelled "Reading lens". The bar is pinned at the top (absolute) and only shown while parallel is on or the lens is not Reading. While Passages runs, two extra switches appear: "Follow blocks" and "Block numbers" ("¹²³"). Strategy: a11y with an exact label match ("Word" vs the popover dialog "Word “…”"; "Passage" repeat chip vs "Passages"). The lens is per session and never persisted.
SRC: apps/mobile/src/components/LensSwitch.tsx:27-89,92-184; apps/mobile/src/app/(tabs)/bible/[abbr]/[book]/[chapter].tsx:385,638-646; packages/core/src/i18n/messages/en/app.ts:145-155

### F22 [verified] Scene 5 step 4: Passages lens — coloured blocks in both languages
Display only. Each verse side's label becomes "{text}. block n: {here}, corresponds to {there}…" (the chunk decorations' labels). Verse sides gain custom accessibility actions "Show correspondence for block n" that XCUITest cannot invoke. Strategy: none needed, or a screenshot for verification.
SRC: apps/mobile/src/components/VerseList.tsx:1121-1134; apps/mobile/src/lens/chunks/chunkDecorations.ts:420,523-526; packages/core/src/i18n/messages/en/app.ts:180-181,633

### F23 [likely] Scene 5 step 5: Word lens — tap the word "shepherd"
Strategy: OCR. Words are never separate accessibility elements. Even in word mode (WordRow, one Text per word) they sit inside the verse side's Pressable, which is accessible by default and hides its children; its label is the verse text. Recipe: get the frame of the element whose label CONTAINS "shepherd" (NIV v1), OCR that region, tap the centre of the "shepherd" box (convert px at @3x to pt). Effects: a single tap waits for the 300 ms double-tap window, then opens the popover. Popover: dialog "Word “shepherd”"; header element "shepherd, Psalms 23:1"; buttons "listen to this word", "listen in NVI", "highlight", "note", "Close". Caveats: two taps within 300 ms count as a double tap and play from that verse. Any auto-scroll (a new verse while following) or drag closes the popover, so pause the audio first. While the popover is open the whole verse list is accessibilityElementsHidden, so close it before querying verses.
SRC: apps/mobile/src/components/VerseList.tsx:31-48,1042-1068,1183-1194,1249-1385; apps/mobile/src/components/verseListLogic.ts:673; apps/mobile/src/components/listTaps.ts:5-28; apps/mobile/src/app/(tabs)/bible/[abbr]/[book]/[chapter].tsx:553-559,649-656; apps/mobile/src/lens/word/WordPopover.tsx:183-230

### F24 [verified] Scene 5 step 6: Enter Focus
There is no per-verse Focus action. Focus is the header chip, a button labelled "Focus" with hint "Opens Focus Mode: one verse per screen, at the verse that's playing". It opens on the verse being heard, else the selection's first verse, else verse 1. It is presented as a transparentModal over the tabs and the mini-player. Strategy: a11y "Focus". The header scrolls away, so return to the top first. Focus screen: eyebrow text "Psalms 23 · 1 of 6" exposed as an adjustable element labelled "Psalms 23, verse 1, 1 of 6" with hint "Swipe sideways to change verses. Swipe down to go back to the chapter." A "Close" button sits top right. Each verse side is one accessible View labelled with its text.
SRC: apps/mobile/src/components/ChapterHeader.tsx:84-99,136-155; apps/mobile/src/components/focusPresentation.ts:17-25; apps/mobile/src/app/focus/[abbr]/[book]/[chapter]/[verse].tsx:351-401,796-800

### F25 [verified] Scene 5 step 7: Focus — swipe sideways to the next verse
Strategy: coordinate, using a press-drag with velocity on the verse stage. Pan activeOffsetX ±20, failOffsetY ±14. It commits on release when |dx| ≥ min(96 pt, 25% of width), or on a fling of ≥32 pt at ≥700 pt/s, and only if |dx| ≥ 1.5·|dy|. Swipe left for the next verse. Verify by the adjustable label changing to "…, verse 2, 2 of 6". The adjustable increment action is not reachable through public XCUITest API.
SRC: apps/mobile/src/app/focus/[abbr]/[book]/[chapter]/[verse].tsx:120,295-341,357-379; apps/mobile/src/components/focusLogic.ts:154-178; apps/mobile/src/components/verseListLogic.ts:628-662

### F26 [verified] Scene 5 step 8: Focus — pull down to return to the chapter
Strategy: coordinate, a downward drag from the stage while its ScrollView is at offset 0. activeOffsetY 14, failOffsetX ±24. It closes when dy ≥ min(140 pt, 20% of height) = 140 on an iPhone 12, or on a flick of ≥24 pt at ≥900 pt/s, with |dx| ≤ dy and velocityY ≥ 0. The system dismiss gesture is off (gestureEnabled false). Fallback: the a11y button "Close".
SRC: apps/mobile/src/app/focus/[abbr]/[book]/[chapter]/[verse].tsx:316-340,387-401; apps/mobile/src/components/focusLogic.ts:365-393

### F27 [verified] Scene 5 step 9: Turn on the bilingual echo ("⇄ echo")
There is no single toggle. The control is the "Bilingual echo" row in Now Playing, with chips "Off", "NIV → NVI", "NVI → NIV" ({from} → {to}). The same chips appear in the Focus footer under the group "ECHO". Choose "NIV → NVI". Directions are disabled, with the reason as their hint and as a note, when the echo cannot run (e.g. "Choose a parallel version in the chapter to hear the echo", "The two versions aren't on the same chapter", "The echo is waiting: a passage is repeating"). The script's "⇄ echo" is the mini-player chip once it runs: visible "echo · book", a11y "Bilingual echo on, book". Strategy: a11y by the direction label. The direction persists in hagah:prefs (echo).
SRC: apps/mobile/src/components/echoControlLogic.ts:58-90; apps/mobile/src/components/RepeatControls.tsx:220-239; apps/mobile/src/components/FocusFooter.tsx:161-172; apps/mobile/src/components/miniPlayerChip.ts:132-141; packages/core/src/i18n/messages/en/app.ts:92-121

### F28 [verified] Scene 6 step 0 (implicit): Return to the "Reading" lens before highlighting
Highlight colours (journal marks) are drawn only in plain reading (marks = null whenever a lens is active), so a highlight made under Passages or Word would not be visible. Tap the tab "Reading" (a11y). Parallel can stay on.
SRC: apps/mobile/src/components/VerseList.tsx:639-658

### F29 [verified] Scene 6 step 1: Tap a verse number
Button with explicit label "Verse 1" ("Verse 1, selected" after selection) and hint "Selects the verse; tapping another number extends the selection". It has a selected state and a 44 pt target. Strategy: a11y; unique per mounted row. It opens the selection bar, not a "· Passage actions" sheet: that sheet and its strings ("HIGHLIGHT VERSE", "PERSONAL NOTE", "Save note") belong to the PWA's VerseActionSheet and are not in the native app.
SRC: apps/mobile/src/components/VerseList.tsx:915-937; apps/mobile/src/i18n/labels.ts:54-57; packages/core/src/i18n/messages/en/shared.ts:53-54,98-108; src/components/VerseActionSheet.tsx

### F30 [verified] Scene 6 step 2: Selection bar (replaces the "· Passage actions" sheet)
A card above the mini-player. The container has role toolbar and label "Actions for Psalms 23:1", with meta text "1 verse · 6 s". Buttons: "Listen", "Repeat", "Playlist", "Highlight", "Note", "More", plus an X labelled "Clear selection". Strategy: a11y, scoped inside the toolbar ("Repeat"/"Listen" exist elsewhere). Caveat: "Listen" and "Repeat" are disabled when the passage has no timings.
SRC: apps/mobile/src/components/SelectionBar.tsx:98-185,274-320; packages/core/src/i18n/messages/en/shared.ts:81-91

### F31 [verified] Scene 6 step 3: Highlight → pick a colour
"Highlight" swaps the bar to colour swatches: buttons "Gold", "Green", "Blue", "Lilac" ("Gold, highlighted" when already applied), "Remove", and a back chevron labelled "Back to actions". Strategy: a11y. Caveat: tapping a colour the verse already has clears it (markPassage toggles), so a leftover highlight from a previous take would turn this step into an un-highlight. The bar stays on the colours panel after the tap.
SRC: apps/mobile/src/components/SelectionBar.tsx:188-231,322-345; apps/mobile/src/components/selectionActions.ts:135-167,225-245

### F32 [verified] Scene 6 step 4: Personal note → type → save
Tap "Back to actions", then "Note". The /note route opens as a modal, not a "PERSONAL NOTE" field. It shows the title "Psalms 23:1", the verse excerpt, and a multiline TextInput (autoFocus, placeholder "Write your reflection or prayer…"). Bar buttons are "Cancel" and "Save" (common.save), not "Save note". Strategy: a11y; type with XCUIElement.typeText into the focused text view (non-secret). The keyboard will appear in the recording. Caveat: if a note already exists on that verse the field opens pre-filled and typing appends. Saving an empty note deletes it. Save is disabled until the journal has loaded.
SRC: apps/mobile/src/app/note.tsx:106-121,148-171,209-226; apps/mobile/src/components/passageSheetPresentation.ts:48-55; packages/core/src/i18n/messages/en/journal.ts:9

### F33 [verified] Scene 6 step 5: Journal tab and filters All · Notes · Highlights
Tab-bar button "Journal" (native UITabBar). Query it inside tabBars, because the screen title Text "Journal" (role header) also matches. The subtitle reads "1 entry" after scene 6 (one row per verse). Filters are role-tab Pressables "All", "Notes", "Highlights", with grouping tabs "By book" / "By date" next to them. The entry row is a button labelled "Psalms 23:1 NIV. {date}. Highlight: Gold. {verse text}. Note: Meditate on this tonight", hint "Opens the chapter at this verse", with row buttons "Edit note", "Delete note", "Remove highlight". Strategy: a11y; match the entry with CONTAINS. Filter state is per session and resets on cold start. There is no share, feed or comment control in the code, which matches the narration.
SRC: apps/mobile/src/components/tabs.ts:26-55; apps/mobile/src/app/(tabs)/journal/index.tsx:318-329,390-461; apps/mobile/src/journal/EntryRow.tsx:53-142; packages/core/src/i18n/messages/en/journal.ts:12-18

### F34 [likely] Scene 7 step 1: Account card — "Sign in with YouVersion" and the native Apple button
Signed out: header Text "Your journal on every device" and body copy. The "Sign in with YouVersion" button has no explicit label; its label comes from the Text. The Apple button is expo-apple-authentication's AppleAuthenticationButton. The RN prop accessibilityLabel="Sign in with Apple" lands on the ExpoView wrapper, which is not an accessibility element. The real control is the child ASAuthorizationAppleIDButton (a UIControl), which exposes Apple's own localized label "Sign in with Apple" on an English device. Query: buttons["Sign in with Apple"], preferring type Button. The button only renders after auth.appleAvailable() resolves, and the card returns null until the Keychain is hydrated, so wait for it. Tapping it presents the Sign in with Apple sheet: system UI and a human checkpoint (Face ID or passcode). Requested scope is FULL_NAME only.
SRC: apps/mobile/src/journal/AccountCard.tsx:37-56,103-155; https://github.com/expo/expo/blob/sdk-57/packages/expo-apple-authentication/ios/AppleAuthenticationButton.swift; apps/mobile/src/auth/native.ts:23,77

### F35 [verified] Scene 7 step 2: Signed-in card, last-sync line and pull-to-refresh
Title Text "Signed in with Apple · {name}", or "Signed in with Apple" when Apple sent no name (it fills fullName only on the first authorization). Sync line: "Syncing…" → "Synced {medium date-time}" (e.g. "Synced Oct 2, 2026, 3:04 PM"), or "Not synced yet". Buttons "Sync" and "Sign out". Pull-to-refresh: coordinate, a slow downward drag from the top of the SectionList. The RefreshControl exists only while signed in. Strategy: a11y BEGINSWITH "Signed in with Apple" / "Synced". Fallback for the refresh: the "Sync" button. Caveat: on sign-in the local journal from scene 6 is merged up to the server.
SRC: apps/mobile/src/journal/AccountCard.tsx:61-100; apps/mobile/src/journal/journalLogic.ts:413-433; apps/mobile/src/app/(tabs)/journal/index.tsx:124-131,238-248; apps/mobile/src/auth/authClient.ts:89-99

### F36 [verified] Scene 7 step 3: Gear → Settings → Account → "Sign out" / "Delete account"
The gear is a button labelled "Open settings". It pushes /settings over the tabs (header title "Settings"; the tab bar is hidden). The Account section is far down a plain ScrollView: section header "Account", the status line "Signed in with Apple · {name}", button "Sign out", and button "Delete account" (hint "Asks for confirmation before deleting."). The description reads "Deletes your Hagah account and the synced journal. Your YouVersion account is not affected." The script omits the second sentence. Strategy: a11y, scrolling first (it is off-screen). Caveat: "Sign out" also exists on the Journal card.
SRC: apps/mobile/src/app/(tabs)/journal/index.tsx:331-347; apps/mobile/src/app/settings/index.tsx:151-153; apps/mobile/src/components/settings/AccountSection.tsx:155-175; apps/mobile/src/components/settings/SettingsKit.tsx:206-240; packages/core/src/i18n/messages/en/journal.ts:56-58

### F37 [verified] Scene 7 step 4: "Delete account?" alert → "Permanently delete account"
This is RN Alert.alert, i.e. a UIAlertController in the app's own process, not a custom modal. Title "Delete account?". The message is one paragraph: "The journal saved on the server — highlights, notes and plan progress — is permanently erased. Sessions on your other devices stop working. This device is signed out and the local copy of the journal is erased. Reading and listening keep working without an account." Buttons: "Cancel" and "Permanently delete account" (destructive). Strategy: system alert, via app.alerts["Delete account?"].buttons[...]. Next, for an Apple account, Apple's sheet appears again for an authorization code used to revoke the token: system UI and a human checkpoint. If that sheet is dismissed or fails, a second alert follows: "Delete without confirming with Apple?" with "Cancel" / "Delete anyway".
SRC: apps/mobile/src/components/settings/AccountSection.tsx:58-100; apps/mobile/src/auth/authClient.ts:507-546; apps/mobile/src/settings/account.ts:74-125; packages/core/src/i18n/messages/en/app.ts:368-380; packages/core/src/i18n/messages/en/journal.ts:59-68

### F38 [likely] Scene 7 step 5: "Account deleted" and back to the Journal
An Alert titled "Account deleted" (no period; "Account deleted." is only in the dev screen). Body: "Your journal was erased from the server and from this device, and you were signed out." The button is RN's default for a button-less Alert, "OK" (RCTUIKitLocalizedString). Then use the navigation back button. It is in minimal display mode, so its label is probably "Back"; fall back to a top-left coordinate. Signals: the Journal card shows the signed-out title again, and the journal is already empty (eraseLocal). Strategy: system alert, then a11y.
SRC: apps/mobile/src/components/settings/AccountSection.tsx:93; apps/mobile/src/settings/account.ts:46-52; apps/mobile/src/auth/authClient.ts:607-617; apps/mobile/src/app/_layout.tsx:58,203-206

### F39 [verified] Scene 7 step 6: Sign in again → empty journal
Same Apple flow as step 1, with a human checkpoint. Empty-state signals: subtitle "0 entries" and Text "Your journal is empty. In the Bible, tap a verse number to highlight it or add a note." Caveat: this leaves the device signed in, the server holding a new empty account, and an active Apple authorization. That changes what the next take's Apple sheet looks like (see risks).
SRC: apps/mobile/src/app/(tabs)/journal/index.tsx:176-188; packages/core/src/i18n/messages/en/journal.ts:13,17-18

### F40 [verified] Scene 8 step 1: Plan tab — current day
Tab-bar button "Plan". Screen header Text "Daily plan", subtitle "Bible in a year · daily audio in Portuguese", button "Go to the current day", and the credit line "Audio: the podcast “Bíblia em um ano” by 4Ventos, used with the producer's permission." It is a FlashList that scrolls itself to the current day after layout. A day row is a button labelled "Day {day}: {readings}, {status} · {N} min[ · Saved]" (e.g. "Day 275: …, Not started · 24 min"), and the current day shows the text "CURRENT DAY". Readings come from the Portuguese feed. Strategy: a11y BEGINSWITH "Day ", or the row next to "CURRENT DAY". The plan feed needs the network.
SRC: apps/mobile/src/app/(tabs)/plan/index.tsx:117-150,297-337; packages/core/src/i18n/messages/en/app.ts:415-433; packages/core/src/i18n/messages/en/plan.ts:15-16

### F41 [verified] Scene 8 step 2: "Tap play" on the day
The list row has no play button. Tap the row to open the day screen; the main button's label comes from its Text: "Listen" (or "Resume at m:ss", "Listen again", "Play", "Pause"). Day-screen navigation buttons are "Back", "Previous day", "Next day"; transport buttons "Back 15 seconds"/"Forward 15 seconds" appear once the day is loaded. Strategy: a11y.
SRC: apps/mobile/src/app/(tabs)/plan/[id].tsx:264-376,720-770; packages/core/src/i18n/messages/en/app.ts:449-456

### F42 [verified] Scene 8 step 3: Mini-player while a plan day plays
The title is "Day N", or the chapter being read with its verse (e.g. "Ezequiel 24 · v. 3", Portuguese book names) once the synced index has loaded and playback has started. The subtitle is "Bible in a Year · Day N". There is no repeat chip for episodes. The script's "Day N · Bible in a Year · 4Ventos" never appears in the mini-player: "Day N · {readings}" over "Bible in a Year · 4Ventos" is the lock-screen metadata. Strategy: a11y label of the mini-player info button, BEGINSWITH "Open Now Playing: Day".
SRC: apps/mobile/src/player/bridge.ts:356-367; apps/mobile/src/player/episode.ts:299-320; packages/core/src/i18n/messages/en/plan.ts:29,36; packages/core/src/i18n/messages/en/app.ts:458-459

### F43 [likely] Scene 8 step 4: Download button for the day
The list row's icon button (label "Download"/"Pause download"/"Resume download"/"Saved", hint "Saves the episode to listen offline") is a Pressable nested inside the row Pressable. With the parent accessible by default it is most likely not exposed, so it needs a coordinate relative to the row: about (row.maxX − 30, row.midY). Preferred route: the day screen's "Download" button (a Text button with that hint). Once saved it becomes "Remove from device", whose confirm alert is "Remove Day N from this device?". Caveat: if a previous take already downloaded the day, the button is gone or disabled ("Saved").
SRC: apps/mobile/src/app/(tabs)/plan/index.tsx:333-389; apps/mobile/src/app/(tabs)/plan/[id].tsx:615-700; packages/core/src/i18n/messages/en/plan.ts:26-27

### F44 [verified] Scene 8 step 5: Playlists tab → a playlist → Play
Tab-bar button "Playlists". The screen header Text "Playlists" and the detail screen's back button "Playlists" also match, so scope the tab to tabBars. A playlist card is a button labelled "{name}. {n} passages · {total}[. Pinned]" (the built-in one is "Memorize"), with hint "Open {name}". In the detail, the play button's label comes from its Text, "Play" (common.play), not "▶ Play", which is the PWA string. Hint: "Plays the playlist from the first passage". Strategy: a11y-ambiguous: "Play" collides with the mini-player, so match on the hint or a frame above the mini-player. Prep: the playlist must already contain passages (stored locally in KV playlists:all; account deletion does not touch it).
SRC: apps/mobile/src/app/(tabs)/playlists/index.tsx:197-252; apps/mobile/src/app/(tabs)/playlists/[id].tsx:285-303,421-436; packages/core/src/playlists/playlists.ts:94,101; packages/core/src/i18n/messages/en/playlists.ts:20

### F45 [verified] Scene 9 step 1: Settings → Downloads ("{size} on this device")
"{size} on this device" is the value of the Settings row, not text on the Downloads screen. Settings has a section header "Downloads" plus a LinkRow labelled "Downloads, {size} on this device" (e.g. "Downloads, 3.4 MB on this device"), or "Downloads, Nothing saved offline yet". Strategy: a11y BEGINSWITH "Downloads," with type Button (the bare "Downloads" header and the next screen's nav title also match). The Downloads screen's top line reads "Offline files: {size}" and "App storage: {used} / {quota}".
SRC: apps/mobile/src/app/settings/index.tsx:73-78,142-149; apps/mobile/src/components/settings/SettingsKit.tsx:44-87; apps/mobile/src/app/settings/downloads.tsx:154-180

### F46 [verified] Scene 9 step 2: Downloads list and the "Download while listening" switch
The switch is an RN Switch labelled "Download while listening" with hint "Keeps the audio of every chapter you listen to…". XCUITest sees a switch with value 0/1. It is off by default (KV hagah:app:downloadOnPlay). Section headers "Chapters", "Plan episodes", "Other audio", "In progress". Each item row is one accessible View labelled "{title}, {detail}[, Pinned][, Open now]", e.g. "Psalms 23 · NIV, text · timings · audio · 1.2 MB" or "Day 275, audio · 23.4 MB". Its Pin and Delete icon buttons are hidden inside the accessible row, so reaching them takes a coordinate tap (they are only needed for resets). Button "Free up space".
SRC: apps/mobile/src/app/settings/downloads.tsx:181-200,228-256,295-367; apps/mobile/src/settings/downloads/inventory.ts:468-507; apps/mobile/src/settings/downloads/downloadOnPlay.ts:20-28

### F47 [verified] Scene 9 step 3: Control Center → airplane mode on
Strategy: system, as a human checkpoint (or Control Center via a swipe from the top-right corner plus a system query). Resume when the status bar shows airplane mode and the app is foreground again.
SRC: plans/mobile/notes/v8.5-roteiro-video.md (Cena 9)

### F48 [verified] Scene 9 step 4: Open the downloaded chapter and press play
Back from Downloads → Settings (back button probably labelled "Settings") → back to the Journal → tab "Bible". The reader still shows the last page (Psalm 23 NIV). Do NOT use the mini-player's "Play" here. After scene 8 the player holds the plan episode or playlist, and an already-mounted reader page never hands its recording to the player again (openedRef === key). Use a double-tap on the verse body ("Double-tap to listen from this verse"; onListen → openChapter → listenFrom), or verse number → "Listen". Offline copy: "No connection" with "This chapter hasn't been opened on this device yet…" for uncached chapters; "Parallel version unavailable offline"; "unavailable offline" in the Word popover; "The {label} narration isn't available offline". Prep: Psalm 23 NIV text and timings must be cached (opened online), and its audio must be fully downloaded (Download while listening ON plus one full play, or played in the take before airplane mode).
SRC: apps/mobile/src/app/(tabs)/bible/[abbr]/[book]/[chapter].tsx:275-289,452-458; apps/mobile/src/components/VerseList.tsx:556-560,706-718; packages/core/src/i18n/messages/en/app.ts:20-22,141,187; packages/core/src/i18n/messages/en/shared.ts:155

### F49 [verified] Scene 10 step 1: Settings → About → licences, plan audio, links
Turning airplane mode off is a system/human step. Settings row: button "About" at the bottom. The About screen (nav title "About") shows header Text "Hagah Bible", "Version 1.0.0 (5)" (STATE says build 5 is the TestFlight build; the script says (4)), "An app by Kingdom Ideas Factory", and "Contact: contato@kifactory.app". Section header "Licenses and attributions" (StaticText, not a button) with the Biblica/YouVersion paragraph and the NVI and NIV notices. Section header "Plan audio" with the 4Ventos credit. Links (role link, hint "Opens in the browser") "Privacy policy" and "How to delete your account", which open SFSafariViewController at hagah.kifactory.app/privacidade/ and /excluir-conta/. Strategy: a11y plus scrolling.
SRC: apps/mobile/src/app/settings/about.tsx:33-104; apps/mobile/src/settings/about.ts:17-20,73-82; apps/mobile/src/app/settings/index.tsx:155-161; packages/core/src/i18n/messages/en/app.ts:617-630

### F50 [verified] Cross-scene: Tab bar labels
NativeTabs (UITabBarController; Liquid Glass on iOS 26) with labels "Bible", "Plan", "Playlists", "Journal" (SF Symbols book, calendar, music.note.list, square.and.pencil). Query them as tabBars.buttons[...], because three of the four names also appear as screen headers or back buttons. Screens pushed on the root Stack hide the tab bar: Settings, Downloads, About, and the Now Playing sheet, the note modal and the Focus modal all cover it. minimizeBehavior is not set.
SRC: apps/mobile/src/components/tabs.ts:26-70; apps/mobile/src/app/(tabs)/_layout.tsx:46-74; packages/core/src/i18n/messages/en/shared.ts:41-44

### F51 [verified] Cross-scene: Deep links usable for preparation
Schemes "hagah" and "app.kifactory.hagah". Universal links applinks:hagah.kifactory.app for /bible, /read, /listen, /auth/callback. All go through +native-intent → resolveIncomingLink. Useful targets: hagah://bible/ENGNIV/PSA/1 (opens the page and, once loaded, stores it as the last position); hagah://bible/ENGNIV/PSA/23?with=PORNVI&lens=word (with= is written to the persisted prefs; lens is per session); hagah://journal, hagah://plan, hagah://playlists, hagah://settings, hagah://settings/downloads, hagah://settings/about, hagah://now-playing. Limits: a link cannot turn parallel off, because the canonicaliser drops with= when it equals the narrated version. /dev/* goes to /bible in a store build. ESV opens as NIV in a store build. Opening from the runner (XCUIApplication(bundleIdentifier:).open(URL) / XCUIDevice.shared.system.open) may raise a system confirmation; that is unverified and needs a spike.
SRC: apps/mobile/ios/HagahBible/Info.plist:27-36; apps/mobile/ios/HagahBible/HagahBible.entitlements; apps/mobile/src/app/+native-intent.tsx:15-22; apps/mobile/src/components/deepLinks.ts:1-34,93-200; packages/core/src/content/routes.ts:133-142,179-203; apps/mobile/src/app/(tabs)/bible/[abbr]/[book]/[chapter].tsx:173-189

### F52 [verified] Cross-scene: Dev tools and test screens are excluded from the store/TestFlight build
DEV_TOOLS = EXPO_PUBLIC_DEV_TOOLS === "1" || __DEV__, inlined at build time. eas.json production sets EXPO_PUBLIC_DEV_TOOLS "0" and EXPO_PUBLIC_STORE_BUILD "1". STATE.md records that build 1.0.0 (5) was archived with exactly these values. When DEV_TOOLS is false: the dev/* routes sit behind Stack.Protected guard={DEV_TOOLS}; each dev screen redirects (devOnly); /dev links are sent to /bible; the Journal title's long-press and the DevLinks footer are gated off; A/B variants are fixed at A/A (double-tap listens). Nothing from development can appear in the recording.
SRC: apps/mobile/src/buildFlags.ts:27-46; apps/mobile/eas.json:43-55; apps/mobile/src/app/_layout.tsx:178-198; apps/mobile/src/components/devOnly.tsx:16-23; apps/mobile/src/components/deepLinks.ts:195; apps/mobile/src/app/(tabs)/journal/index.tsx:97,227-236,322; plans/mobile/STATE.md:467-470

### F53 [verified] Cross-scene: TestFlight build vs a local simulator or dev build
Differences that change targets or behaviour. (1) A non-store build (STORE_BUILD false) lists ESV in the pickers, which adds elements. (2) A development/preview or Metro build has DEV_TOOLS on: the Journal shows DevLinks (opened from the start under Metro), the dev routes exist, and LogBox or the dev menu can overlay the UI. (3) An iOS < 26 simulator uses the floating overlay mini-player instead of the tab-bar accessory, so positions and hierarchy differ. (4) A simulator has no airplane mode or Control Center toggle, a different Sign in with Apple and Face ID flow, and different lock-screen behaviour. (5) A local build may lack the YouVersion key ("Sign-in unavailable: the YouVersion key isn't configured."). (6) About shows a different version/build. (7) A device-run Release build was installed earlier over the network (STATE: devicectl install from 7ded7db, where holding the Journal title opened the dev screens). Confirm the iPhone now has the TestFlight build 5 by checking About.
SRC: apps/mobile/src/content/storeVersions.ts:34-53; apps/mobile/src/components/miniPlayerHost.ts:57-66; apps/mobile/src/app/(tabs)/journal/index.tsx:97; packages/core/src/i18n/messages/en/shared.ts:243; plans/mobile/STATE.md:200-205,467-470

### F54 [likely] Cross-scene: State that persists between takes and must be reset
Persisted in KV (SQLite in the app container): hagah:prefs = last position, parallelAbbr, mirrorMode, repeat (incl. the Sleep preset's book ∞), afterRange, echo, presets; hagah:app:lens; hagah:app:locale (a stored interface language overrides the device's); hagah:app:theme; hagah:app:typography; hagah:app:downloadOnPlay; hagah:app:defaultVersions; journal:data (local highlights and notes); playlists:all; podcast:progress; downloads (blobs plus index). The session token lives in the Keychain (expo-secure-store, AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY) and probably survives an app delete. Per session or memory only, reset by a cold start: the lens, the sleep timer, the player, the Journal filter, the follow state. Reset checklist: in-app language English or unset; signed out; journal 0 entries (delete note and remove highlight, or rely on scene 7's deletion); Parallel → "Turn off"; Repeat Off; Bilingual echo Off; Speed 1×; presets default; last position = Psalm 1 NIV (not Psalm 23); the plan day not downloaded; Psalm 23 NIV audio downloaded; a playlist with items; then terminate the app. A take that completes scene 7 erases the local journal (eraseLocal) but ends signed in again.
SRC: apps/mobile/src/state/readerPrefs.ts:41-48; packages/core/src/reader/prefs.ts:109-120,307-310; apps/mobile/src/settings/localeSetting.ts:21,35-44; apps/mobile/src/auth/localJournal.ts:19,46-61; apps/mobile/src/auth/native.ts:37-38,62-64; apps/mobile/src/ports/ExpoStorage.ts:19-21; packages/core/src/playlists/playlists.ts:94; packages/core/src/plan/podcastProgress.ts:27


## SOURCES
- Video script v8.5 (10 scenes): file:///Users/noah/project/bible/hagah/plans/mobile/notes/v8.5-roteiro-video.md
- Contrarregra spec prompt: file:///Users/noah/project/bible/hagah/plans/mobile/notes/v8.5-prompt-contrarregra.md
- English UI strings (app/shared/journal/plan/playlists): file:///Users/noah/project/bible/hagah/packages/core/src/i18n/messages/en/
- Reader screen: file:///Users/noah/project/bible/hagah/apps/mobile/src/app/(tabs)/bible/[abbr]/[book]/[chapter].tsx
- VerseList (verses, words, gestures, FlashList): file:///Users/noah/project/bible/hagah/apps/mobile/src/components/VerseList.tsx
- ChapterHeader / ReferencePicker / MirrorPicker / LensSwitch / SelectionBar: file:///Users/noah/project/bible/hagah/apps/mobile/src/components/
- Now Playing, RepeatControls, SleepTimer, echo logic: file:///Users/noah/project/bible/hagah/apps/mobile/src/app/now-playing.tsx
- Focus screen: file:///Users/noah/project/bible/hagah/apps/mobile/src/app/focus/[abbr]/[book]/[chapter]/[verse].tsx
- Journal tab, AccountCard, EntryRow: file:///Users/noah/project/bible/hagah/apps/mobile/src/app/(tabs)/journal/index.tsx
- Settings, AccountSection, Downloads, About: file:///Users/noah/project/bible/hagah/apps/mobile/src/app/settings/
- Plan list and day screens: file:///Users/noah/project/bible/hagah/apps/mobile/src/app/(tabs)/plan/
- Playlists screens: file:///Users/noah/project/bible/hagah/apps/mobile/src/app/(tabs)/playlists/
- Build flags and EAS profiles: file:///Users/noah/project/bible/hagah/apps/mobile/src/buildFlags.ts
- Deep link resolution: file:///Users/noah/project/bible/hagah/apps/mobile/src/components/deepLinks.ts
- Reader prefs persistence: file:///Users/noah/project/bible/hagah/apps/mobile/src/state/readerPrefs.ts
- Auth client (Apple revoke, delete order): file:///Users/noah/project/bible/hagah/apps/mobile/src/auth/authClient.ts
- Mobile STATE (builds, TestFlight 1.0.0 (5) flags): file:///Users/noah/project/bible/hagah/plans/mobile/STATE.md
- PWA VerseActionSheet (source of the script's scene-6 strings): file:///Users/noah/project/bible/hagah/src/components/VerseActionSheet.tsx
- expo-apple-authentication AppleAuthenticationButton.swift (SDK 57): https://github.com/expo/expo/blob/sdk-57/packages/expo-apple-authentication/ios/AppleAuthenticationButton.swift
- react-native-screens bottom accessory helper (hides the inactive placement): https://github.com/software-mansion/react-native-screens/blob/main/ios/tabs/bottom-accessory/RNSTabsBottomAccessoryHelper.mm
- Expo Router native tabs docs (bottom accessory renders two instances): https://github.com/expo/expo/blob/sdk-57/docs/pages/router/advanced/native-tabs.mdx
