# Slip-box architecture

How this application is built, for people joining the project. It covers the idea, the building blocks, how they exchange information, the contracts between them, the pages that compose them, the libraries we lean on, and how the rules are enforced. It contains no implementation.

---

## 1. The idea

Niklas Luhmann wrote dozens of books without ever sitting down to write a book. He wrote thousands of small, finished notes, each on one idea, each pointing by name to related notes, and kept them in a slip-box. A book was a path through the box. He could work on whatever interested him that day, change his mind after any note, and the collection still grew into something coherent.

We build software the same way. A **component** is a note: small, complete, tested, useful on its own. Components never touch each other. They announce facts, give instructions, and ask questions through one shared piece of infrastructure, the **bus**, which is the slip-box. An **app** is a path through the box: a page that lists which components to load and nothing else.

The property we optimise for: anyone, including a coding agent, can add, rewrite, or delete a component without opening any other component.

---

## 2. The mapping

| Luhmann | Here |
|---|---|
| A note: one idea, finished, self-contained | A component: one concept, or one way of looking at it |
| The slip-box | The bus |
| A pointer ("see 21/3d7") | Subscribing to a named event, or addressing a named component |
| The index card at the front of a stem | A component's manifest |
| A stem: a note and its follow-ups | A stem: a fact component and its views |
| A book | An app page that declares which components to compose |
| Working on whatever is interesting today | Adding a component nobody planned for |

Where the analogy strains: a book only has to read well, an app has to run. So pointers between components are stricter than Luhmann's. They are contracts (section 7), and changing a contract is the one thing that can break a neighbour.

---

## 3. Building blocks

```mermaid
flowchart TB
    subgraph browser [Browser]
        bus[Bus]
        subgraph facts [Fact components]
            notes[notes]
            conv[conversations]
            llm[llm]
            session[session]
            settings[settings]
        end
        subgraph views [View components]
            editor[note-editor]
            list[note-list]
            reader[note-reader]
            chat[chat-thread]
        end
        bus <--> notes
        bus <--> conv
        bus <--> llm
        bus <--> session
        bus <--> settings
        bus <--> editor
        bus <--> list
        bus <--> reader
        bus <--> chat
    end
    subgraph server [Server: FastAPI]
        notesApi[notes/server]
        convApi[conversations/server]
        llmApi[llm/server]
        sessionApi[session/server]
    end
    notes <--> notesApi
    conv <--> convApi
    llm <--> llmApi
    session <--> sessionApi
```

Every line between a component and anything else goes through the bus. The only exception is a fact component talking to *its own* server module, which is the same component on the other side of the network.

A view may load an image by a URL a fact's reply or event handed it. The fact's server module serves it, and the browser's HTTP cache is the only copy.

### 3.1 Two kinds of component

**A fact component owns a concept.** The notes, the conversations, the settings, the current session, access to the language model. It is headless. It is the single place the fact lives. It emits an event whenever the fact changes, and it answers queries about the fact.

Where it stores the fact is its own business, and there are three shapes:

| Shape | Storage | Offline | Example |
|---|---|---|---|
| **Local-only** | Browser only: localStorage, IndexedDB, memory | Always works; follows the device | `settings`, `trace`, `viewport`, `subject` |
| **Replicated** | Browser cache + server, kept in sync (section 5) | Works; syncs later | `notes`, `conversations`, `session` |
| **Remote-only** | The fact can only be produced by the server | Fails honestly, with an error reply and, where other views need to know, an `unavailable` event | `llm`, `catalog`, `pages` |

A fact component that needs the server brings its own server module with it, in the same directory (section 11.1). `llm` is remote-only in this sense: the model's answer can only come from the server, and `llm`'s server module also holds the account's model settings — provider, model, thinking effort, cache lifetime — and the API key, encrypted at rest and never sent back to the browser (7.7), so those preferences are the same on every device.

A fact may be **derived**: it stores nothing and combines what other facts announce into one answer several components need. `subject` is the one such fact: what the user is working on, as `{ kind, id, title, view }`, or null. Some views show a thing: `book-reader` shows the open book (`books: open`). The subject is the thing shown by the view of that sort that was last in front on the stage. It stays the subject while any other view is in front — `highlight-notes`, `note-list` — because those views are about the subject and do not replace it. After a reload, before any such view has been in front, the subject is the open item of the first view in the table that has one. `view` is the address of the view that shows the subject. `subject` asks `dock` and `books` for the starting picture and follows their events after (4.3) like any asker, and it announces `subject.changed` only when the answer differs. The table from a view to the kind of thing it shows lives in `subject` alone, so a new kind of thing changes one component, and a follower compares `kind` and `id` without knowing what kinds exist.

**A view component owns a way of looking at or acting on a concept.** Editing, listing, reading, chatting. It owns only its own UI state: cursor position, scroll, which tab is open, the draft in the input box. It points at one or more fact components, queries them, listens to their events, and emits events about what the user did. It never holds a copy of a fact it would be sad to lose. UI state worth keeping across a reload — which note is pinned, say — a view may keep in localStorage under a key beginning with its role or name; it follows the browser, never the account, and losing it loses nothing.

### 3.2 Inside a component

Every component, of either kind, has an **actor**: its brain, a mailbox processed one message at a time, where all decisions are made. View components add a **view**, the visible part, which renders the actor's state and forwards user gestures to the actor as commands. Fact components add a **store**, their private persistence, and possibly a **server module**.

Every component also has a **browser entry**, the one file a page loads: `view.js` for a view, `fact.js` for a fact. `fact.js` creates the actor with its inputs and mounts it on the bus; `machine.js` itself starts nothing, so it can be imported anywhere.

A component's **manifest** (section 7.3) is not a separate file: it is read from the actor's definition.

### 3.3 The bus

The one shared piece of infrastructure, built once. It carries events, commands, and queries (section 4), routes each to the right mailboxes, validates every event, and every query's payload and reply, against the contract registry, refuses emits a component has not declared, and knows nothing about what any event means. It keeps nothing: there is no event log. The one thing it holds is transient routing state, not retention: an event an asker's open query declares as superseding its answer (4.2), kept only until that query's reply lands. Facts persist in fact components; the bus is only how the news travels.

The bus has one tap: a listener called synchronously with a record of every routing decision, an event or a query and its outcome. The bus still keeps nothing; the `trace` fact component keeps the session's records. A field a schema marks secret (7.2) never reaches a record: the bus replaces its value with a fixed marker before the tap sees it, so the trace, the console and other tabs never carry it — this is how an API key travels to `llm` without appearing anywhere.

### 3.4 The server

Not special. It is the far end of the fact components that chose to have a server side. Each such component owns its own FastAPI router, mounted at `/api/<component>`, its own SQLite database, and its own migrations. The server discovers routers by walking the components directory. There is no shared sync endpoint and no shared database.

Authentication is one more fact component: `session`. Its server module runs the passkey (WebAuthn) ceremonies and sets an HttpOnly cookie; its browser actor never sees the cookie, it queries its own server module for "who am I" and emits `session.changed`. Nothing else in the system knows authentication exists.

### 3.5 Pages

A page is an HTML file the browser loads: an import map and a list of component tags, nothing else. The tags are the page's *default* composition (3.6). There are five kinds, described in section 8, and an app is one of them.

### 3.6 The composer

A page's tags are the default composition, not the final one. The **composer** is the second piece of shared infrastructure after the bus: loaded once per page, it reads which implementation the user chose for each swappable **role** (7.3) and mounts that one in place of the page's default, re-swapping when the choice changes. Besides a document fact (7.5) it is the only thing allowed to change the page after load, and it changes only role-bearing elements, in place — never `html`, `head`, or `title`.

Like any asker it queries `settings: read` for the starting picture and follows `settings.changed` after (4.3); being infrastructure rather than a component, it may import a chosen variant's `view.js` by URL to define it. A swap removes the default element — whose actor unmounts cleanly on disconnect, leaving nothing on the bus — and inserts the chosen one with the same attributes and DOM position, so the view keeps its place in the dock (12).

---

## 4. Three kinds of information

Everything goes through the bus. There is no other channel.

| | Event | Command | Query |
|---|---|---|---|
| What it is | A fact that happened | An instruction | A question |
| Tense | Past: `note.saved` | Imperative: `focus` | Interrogative: `read(id)` |
| Addressed to | Nobody; broadcast | One instance, by name | One fact component, by name |
| Reply | Never | Never | Always, routed back to the asker |
| Who may send | The fact component that owns the fact, or the view where the user acted | Anyone | Anyone, but only fact components answer |
| Persisted | No | No | No |

### 4.1 How addressing works

Every component instance has an address: its name, and an instance id when a page holds more than one (`notes`, `note-editor#1`, `note-editor#2`). A command or query names its target; the bus places it in that mailbox. An event names no target; the bus places it in every mailbox that subscribed to that event name.

### 4.2 How queries work

A query is a message carrying the target address, the query name, its payload, and a **correlation id** generated by the asker. The bus delivers it to the target's mailbox. The target's actor answers by sending a reply carrying the same correlation id; the bus routes the reply to the asker's mailbox, and the asker matches it to the question it had open. A query that reaches no fact component, or a fact component that cannot answer (offline, not found), still produces a reply, one that says so. The asker never waits on anything but its own mailbox.

In the browser this is `ask(machine, target, name, payload)` on the bus: it returns a promise that settles when the reply reaches the asker's mailbox, and a machine consumes it through `fromPromise`, the function arriving through `input`, so the machine stays importable in Node. A query to a target nobody mounted is replied to at once with `{ error: "no-answerer" }`; one the target does not answer with `{ error: "unknown-query" }`. A query whose payload does not match its schema is not delivered and is replied to with `{ error: "invalid-payload" }`; a reply that does not match its schema does not reach the asker, which gets `{ error: "invalid-reply" }` instead, so one malformed answer cannot take down the fact that produced it. A query aimed at a view, or one the asker did not declare (section 7.3), is refused.

A query's schema names, in `supersededBy`, the events that supersede its answer. While the ask is open the bus holds those events for the asker alone and releases them, in order, once the reply has landed, so the asker sees the starting picture first and everything after it after. The hold ends at the reply, or at `unanswered` if none comes; it never starts for a refused query or one no fact answers. Other subscribers are never delayed: an event held for one asker reaches everyone else at once. This is what makes the first half of the fourth rule (4.3) true by construction.

### 4.3 The five rules

**Every fact has exactly one owner.** If two components need the notes, one of them is `notes` and the other asks it. There is no shared database in the browser and no copy that can drift.

**Only fact components answer queries.** A view queries `notes`, never `note-list`. If a view wants to know what another view is showing, that view should have emitted an event (`note.opened`) and this one should have listened.

**Events are self-contained.** `note.saved` carries the whole note, not an id that forces the consumer to ask. This costs duplication and buys isolation. Volume is not a concern: inside the browser a whole note per event is free, and the view that produces changes coalesces at source, so an editor emits `note.saved` at a short throttle while the user types and at once on blur, never per keystroke. The fact component announces each one immediately; what it debounces is the network (section 5), not the news.

**Query for the starting picture, subscribe for everything after.** A view that queries `notes: read(id)` must also listen to `note.changed`, and must treat any later event with a newer version as authoritative. The bus makes the first half true by construction: an event the query names as superseding its answer is held for the asker until the reply lands (4.2), so an event that races the starting query is not lost. Version comparison remains for a later event that comes from elsewhere — another device's edit pulled by `notes`, after the hold is long closed. Nothing may assume some other component finished reacting first.

**A fact component learns what the user did from events.** A view where the user acted emits the gesture as an event (`note.saved`, `viewport.selected`); the fact component that owns the concept consumes it. Commands address views: one instance among several, or an instruction that is not a fact (`focus`, `load(id)`).

---

## 5. Storage and sync

Fact components are **local-first**: a change is written locally and announced immediately; the server learns about it afterwards. The user never waits for the network, and the app works offline for every replicated and local-only fact.

For replicated fact components:

- The browser side keeps a cache in IndexedDB and an **outbox**: records changed locally and not yet acknowledged by the server. A row is deleted the moment the server acknowledges it. The outbox is the only thing in the browser that must not be lost.
- A record changed locally is marked *pending* until acknowledged. Views may show this.
- The fact component drains the outbox whenever it can, coalescing by record id so three offline edits become one write.
- On page load and whenever the tab regains focus, it first drains the outbox, then pulls what changed on the server. A save drains once typing has paused, without a pull, and a tab going to the background drains at once, so another device finds the latest copy. This is how work started on a MacBook continues on an iPhone and back: no live stream, no manual refresh.
- Every record carries a **version**, assigned by the server. A write states the version it was based on. The server rejects a write based on a stale version, and the fact component emits a `conflicted` event carrying both copies, so a view can show them rather than silently losing one. This is what makes it safe to leave a tab open on one device and continue on another. Simultaneous editing on two devices is not a goal.
- Ids are generated in the browser (ULIDs), and server writes are idempotent upserts, so retries and duplicates are harmless.
- A deletion is a write like any other: the record stays as a **tombstone** (a `deleted` flag), versioned and pulled like a change, so a pulling device learns the note is gone; it is never purged. A delete carries no base version and is not refused for a stale one — a delete always wins, and an edit that reaches the server after a delete comes back as a conflict rather than reviving the note. The fact keeps the tombstone's title and body, so what was deleted can still be shown or restored later.

On the server, each replicated fact component has **one SQLite file per user**: `data/<user>/<component>.db`. The session resolves the user, the component's router resolves the file, and neither the schema nor the browser ever mentions users. The backend is written as if for a single user. Litestream streams every file continuously to object storage; the architecture never sees it, and restoring is one command.

`session` is the exception: it keeps one shared file `data/session.db`, the identity registry, because it defines users and so cannot be per-user. While no user is signed in a replicated fact's outbox does not drain; signing in starts draining, so what was written anonymously becomes the account's, and what was not acknowledged before sign-out uploads at the next sign-in.

While anonymous, `notes` mints versions in the browser and the server adopts the client's number on first upload, so the anonymous note carries its history into the account. Registration is capped by `MAX_USERS`; once the registry is full `session` reports `registrationOpen` false and refuses a new passkey with `registration-closed`. `session`'s own replicated shape is not an outbox but a localStorage cache plus an owed sign-out, because identity has no records to version: there is nothing to base a write on, only the single fact of who is signed in.

`books` is the other exception: its rows replicate as above, but its chapters and images are extracted once at import into `data/<user>/books/<id>/`, and the source file is kept there only for re-import. A re-import is run on the host, by `deploy/`, from the kept source under the next content version, so every chapter and image URL changes and the old cache lapses. The row carries the metadata that rides the bus; the directory holds what the browser fetches by URL, and the epub is never reopened. A reading position is last write wins: it carries no base version and is never refused. A title the user gives a book is the same: last write wins, kept beside the title read from the file, which a re-import refreshes without touching the user's; an empty title restores the file's. Which book is open is one more last-write-wins value: `books` keeps it beside the rows, the server holds a single per-user copy, and a pull brings it, so a reload or another device opens what was being read. The files are copied to the same bucket by `deploy/`, as the databases are by Litestream.

`conversations` replicates like `notes`, but a chat has no version to base a write on because its parts do not change once written. A turn is immutable the moment it is finished, and turns carry the ids the browser minted, so the server merges them by id: two devices adding to one chat each upload their own turns and neither overwrites the other, and there is no conflict to show. The chat row itself — its title, its links, which turns belong to it — is last write wins, and a delete always wins, exactly as a book's. A chat's tool preferences (which lookups are on, and whether lookups are approved by hand) are one more last-write-wins value per account, kept beside the rows and pulled like `books`'s open book. Which chat is open is per device, like a reading position on paper: it is kept in the browser only, not synced, because each device may be looking at a different chat.

---

## 6. Interactions

Every diagram below routes through the bus, because that is the only way anything travels.

### 6.1 Writing a note (local-first)

```mermaid
sequenceDiagram
    participant U as User
    participant E as note-editor
    participant B as Bus
    participant N as notes
    participant S as notes/server

    U->>E: types
    E->>E: throttle
    E->>B: event note.saved(note)
    B->>N: note.saved(note)
    N->>N: cache (pending) + outbox
    N->>B: event note.changed(note, pending)
    B->>E: note.changed
    N->>N: debounce
    N->>S: PUT /notes/{id} (note, baseVersion)
    S-->>N: ok, version
    N->>N: clear outbox row, clear pending
    N->>B: event note.changed(note, version)
    B->>E: note.changed
```

The editor is finished the moment it emits. Every other view interested in notes learns of the change the same way, from `note.changed`, whether it came from this tab, from the server, or from another device.

### 6.2 Continuing on another device

```mermaid
sequenceDiagram
    participant M as MacBook: notes
    participant S as notes/server
    participant P as iPhone: notes

    M->>S: PUT note (based on v3) → v4
    P->>S: tab focus: pull
    S-->>P: note v4
    Note over P: edit → PUT (based on v4) → v5
    M->>S: tab focus: drain outbox
    M->>S: pull
    S-->>M: note v5
```

If the MacBook still had an unsent edit based on v4 when it regained focus, the server rejects it and `notes` emits `note.conflicted` with both bodies.

### 6.3 A chat about my books

The store, not a view, asks the model, so closing the panel loses nothing. The answer arrives as events, piece by piece. When the model asks to look something up, `conversations` asks the query the owner marked as a tool (7.7) and feeds the result back into the next round.

```mermaid
sequenceDiagram
    participant U as User
    participant I as chat-input
    participant B as Bus
    participant V as conversations
    participant L as llm
    participant N as a fact (a tool)
    participant C as chat-thread

    U->>I: asks a question
    I->>B: event turn.submitted(turn, about, start)
    B->>V: turn.submitted
    V->>V: append the user turn and a pending assistant turn
    V->>B: event conversation.changed(pending)
    B->>C: conversation.changed
    V->>B: query llm: complete(id, start, turns, tools)
    B->>L: complete
    L->>B: reply { id }
    loop while the model works
        L->>B: event completion.progressed(text so far, calls, done)
        B->>V: completion.progressed
        V->>B: event conversation.changed
        B->>C: conversation.changed
    end
    Note over V: the finished assistant turn carries tool calls
    V->>B: query N: <tool>(input)
    B->>N: <tool>
    N->>B: reply
    V->>V: store the result on a new user turn
    V->>B: query llm: complete(…, turns with the result)
    Note over V,L: another round, until the model answers with no calls
```

`chat-thread` and `chat-input` hold only UI state — the transcript scroll, the draft in the input box. The transcript is owned by `conversations`, model access by `llm`, and each tool is another fact's own query. Any of them can be replaced without touching the others.

### 6.4 Adding components nobody planned for

Suppose the build order is: `notes` + `note-editor`, then `note-list`, then `split-view`, then `chat-thread`, then `note-reader`.

- `note-list` queries `notes: list` on start, subscribes to `note.changed` and `note.deleted`, emits `note.selected` and, when a note's undo window runs out, `note.discarded`. Nothing existing changes.
- `split-view` is nearly pure declaration: two slots, and a `follows` attribute that turns `note.selected` into a `load(id)` command on the chosen slot.
- `chat-thread` queries `notes` and `llm`, emits `turn.submitted`, which `conversations` consumes. Nothing existing changes.
- `note-reader` subscribes to `note.selected`, queries `notes: read(id)`. Nothing existing changes.

Each later component used only contracts that already existed, and the components page (section 8) showed which ones were available before it was built. This is the Zettelkasten property made concrete: a new note points at old notes; old notes do not change.

A page may declare a view's home side with a `side="left|right|bottom"` attribute on a `dock-desk` child, read like the `label` convention (neither is a `dock-desk` tag attribute). `dock-desk` seeds the initial layout from the declared sides — open, or with left and right folded where the desk is too narrow to hold a dock beside the stage — only when the `dock` fact has no stored arrangement; the first user gesture stores a layout, and that stored layout wins thereafter. The layout fact stays owned by `dock` — `dock-desk` only chooses a starting picture when the fact has none. A `dock-desk` child carrying `control` is not a view: it gets no tab and no place in the layout, and sits at the trailing end of the stage header. A `dock-desk` child may also carry `shows-on="<event>"`, naming one of the selection gestures `dock-desk` consumes (`book.selected`, `note.selected`, `conversation.selected`): when that event arrives the desk shows the child's tab where it sits — on the stage, or on its side, unfolding it — the same as a click on the tab, stored through `dock.arranged` like any gesture. The gesture is followed, not the fact's `*.opened` news, so a reload or another device's pull never moves a tab.

A `dock-desk` carrying the `reorders` attribute offers, while the desk is being arranged, two buttons in each dock's strip that move the shown tab one place earlier or later on its own side, stored through `dock.arranged` like any gesture. The buttons appear only on a side that holds more than one tab, and each is disabled at its end of the strip. The stage's tabs keep the page's order, which the layout does not store.

---

## 7. Contracts

Contracts are the only coupling in the system. Every contract is **declared once, in the component that owns it, and derived everywhere else**. Nothing is hand-copied onto a page, and section 11 makes a stale declaration fail at runtime rather than drift.

### 7.1 Event vocabulary

Every event has a name, an owner, and a JSON Schema for its payload, kept in the owning component's directory. Names are `subject.pastTenseVerb`. The set of all event schemas is one of the three shared vocabularies of the system (the others are the design tokens and the icons), and it is kept small on purpose.

The events of every component that has a directory in `components/` are not listed here, because a list in this document would be a second copy that drifts from the schemas. Read them from the running system instead: `python3 checks/show.py contracts` prints every event with its owner and its fields, and `python3 checks/show.py contracts <name>` prints one event's full schema and the components that consume it. The contracts page (section 8) shows the same in the browser. A component that is planned but not built (only a `machine.js` and its schemas, no browser entry) still has a directory, so the running system reads its events too; nothing is listed in this document.

Payload shapes are only ever **extended**: never a removed field, a renamed field, or a new required field. Nor is a shape ever **narrowed**: a `type` may not lose an alternative, an `enum` or `const` may not lose a value, a `oneOf`/`anyOf` may not lose a branch, and `additionalProperties` may not go from open to closed. The same holds for query payloads and replies (7.2) and command payloads. If a change cannot be additive, it is a new event with a new name.

Because the vocabulary is shared, it is not grown casually: **adding an event, or changing an event schema, needs explicit permission from the user first**, even when the change is additive. The proposal names the event, its owner, its payload, and the component that needs it; nothing is written until it is approved. The same holds for the design tokens (section 7.4).

### 7.2 Command and query contracts

Every command a component accepts, and every query a fact component answers, is named, with the shape of its payload and, for queries, the shape of the reply.

They are read from the running system the same way as the events (7.1): `python3 checks/show.py contracts` lists every query and command of a component, built or planned.

What a machine handles is read from the keys of its `on` handlers, in any state, by one convention: a dotted name (`note.changed`) is a consumed event; a name ending in `?` (`list?`) answers the query of that name; a leading underscore (`_mediaChanged`) is an internal message the bus never routes; anything else is an accepted command. A query is delivered to the answerer as `{ type: "list?", cid, payload, reply }`, and the answerer calls `reply(value)` exactly once.

A query's payload and reply shapes are JSON Schemas in the answerer's `queries/<name>.json`, as `{ payload, reply, supersededBy }`, where `supersededBy` names the events that supersede the answer (4.2), an array the bus holds for the asker until the reply lands; a command's payload shape is in the acceptor's `commands/<name>.json`. The bus validates a query's payload on delivery and its reply before it reaches the asker, so a query schema cannot go stale, the same as an event's. A query schema may also carry a top-level `tool` entry — a `description` for the model and a short `label` for people — which is the owner opting the query in as a tool the chat may offer the model (7.7); it changes nothing about how the query is asked or answered. A reply string may carry `"contentMediaType": "text/html"`, which tells the tool loop (7.7) to hand the model that field as markdown rather than raw HTML. A property of an event payload, a query payload or a reply may carry `"x-secret": true`; the bus then hides that field's value from the trace, the console and other tabs (3.3), while the receiver still gets the real value.

### 7.3 Manifest

A component's manifest is not written by hand. It is read from the actor's definition:

- **consumes**, **accepts**, **answers**: derived from what the actor's machine handles.
- **emits** and **asks**: the two things that cannot be discovered by inspection, so they are declared as metadata on the machine itself, next to the handlers. `emits` lists event names; `asks` lists `"target: query"` strings, and may hold the one wildcard `"*: tool"`, which lets the asker ask any query whose schema carries a `tool` entry (7.7). The bus refuses any emit or ask not on its list, so the declarations cannot go stale without the code failing.
- **kind**, **shape**, **attributes**, and **owns**: metadata on the same machine. **shape** (section 3.1's storage shapes) and **owns**, a short lowercase noun phrase naming the fact, belong to fact components only; **attributes**, the ones the tag understands, to view components only.
- **role** (view components, optional): a lowercase name for a slot of interchangeable implementations — `note-editor` and `note-editor-cm6` (a CodeMirror 6 rich editor with Vim) both declare `role: "note-editor"`. Members of a role share a contract (same emits, asks, accepts, answers), so one stands in for another; the composer (3.6) uses the role to know which are alternatives, and a page's tag for a role is its default.
- **status** is not declared. A component is *built* when its browser entry exists (`view.js` or `fact.js`), *planned* when it has only `machine.js` and `events/`.

From manifests alone the system computes, for every component, the components it interacts with: for each consumed event, who emits it; for each emitted event, who consumes it; for each query, who answers it.

Manifests reach the browser through one fact component, `catalog`: remote-only, owning every component's manifest. Its server module walks `components/` and runs the manifest reader, `checks/manifests.mjs` under `checks/register.mjs`, which is infrastructure like the bus, so the check and the page read the same thing; the interactions are computed there too.

### 7.4 Design tokens

The visual vocabulary: a small set of CSS custom properties for colour, spacing, type, radius, motion. Views use tokens and nothing else: every colour, every length that places or sizes a box, every type value is a token or a `calc()` of tokens. Tokens are the second shared vocabulary and are kept minimal: a token exists because a view uses it, and a token nothing uses is removed. Every change to `tokens.css` needs explicit permission from the user first.

The document layer is three files: `tokens.css`, the custom properties; `base.css`, the `@font-face` declaration, the inherited properties set on `html` and `body`, and the rules by which the document reacts to a document fact (7.5); and `icons.js`, the icons (7.6). There are no shared utility classes, because shadow DOM stops a class selector at the component boundary; only inherited properties and custom properties cross it, which is why tokens can theme a view and a `.btn` class could not.

### 7.5 Document facts

A few facts are properties of the document itself rather than of any view: which colour scheme the page is in, and later perhaps its language or direction. A fact component that owns such a fact writes it as exactly one attribute on `html`, `data-<its name>`, and touches nothing else in the DOM. Views only ever read the document. The list is closed: adding a row, or changing what a row writes, needs explicit permission from the user first, the same as an event or a token.

| Component | Writes |
|---|---|
| `color-scheme` | `data-color-scheme` |
| `viewport` | `data-viewport` |

### 7.6 Icons

The glyphs views may use: the third shared vocabulary, beside the events (7.1) and the tokens (7.4). They are Phosphor Icons, regular weight, copied one icon at a time, path data only, into `tokens/icons.js`, and reached as `icon(name)` from the bare specifier `icons`. An icon is sized `1em` and filled `currentColor`, so it matches the text it sits in and follows the scheme. The set is closed: an unknown name throws. An icon exists because a view uses it, and one nothing uses is removed. Adding one needs explicit permission from the user first: the proposal names the Phosphor name and links `https://phosphoricons.com/?q=<name>`, so the glyph is seen before it is approved. The tokens page shows every icon. Running text keeps typographic arrows: a `→` in a table header is prose, not an icon.

### 7.7 Tools

When the user chats with the language model, the model can look things up in the user's own library. **A tool is nothing more than one of the system's own queries.** A fact component opts one of its queries in by adding a `tool` entry to that query's schema (7.2): a `description` written for the model and a short `label` written for people ("Reading a chapter"). Nothing in the chat is hard-coded to a particular tool — a new fact's opted-in query becomes a tool the model can use with no change to the chat. Because a tool is a query, **a tool only ever asks; it never acts.** If a query gives the model too much or too little, the fix is to improve the query for everyone, never to wrap it.

Two gates stand between the model and a lookup. The owner opts the query in (the `tool` entry). Then the user keeps it on: `conversations` remembers, per account, which tools are on (all on by default) and whether lookups are approved by hand (the default) or automatically. Approval by hand shows one card per round listing each call by its owner's label, with Allow and Reject; Reject ends the round, and the chat waits for the user to say what they want instead, sending that redirection together with the rejection as one turn. The interface never says "lookup" to the user in jargon; it names what is being read.

**The loop that runs the tools lives in `conversations`, not in a view**, so closing the chat panel loses nothing. When a finished answer carries tool calls, `conversations` asks each call's query, stores the result on the conversation, and asks the model again with the results included; the model reads them and either answers or asks for more. Results are stored and sent again each round exactly as they were first produced — never recomputed, never summarised by another model — so the provider's cache holds. Two guards bound the cost: each result is cut at 120,000 characters (with a line saying it was cut), and a single question runs at most eight tool rounds. A reply field the owner marked `contentMediaType: text/html` (7.2) is handed to the model as markdown, converted by our own small converter.

Because a model's proposed tool input is untrusted, `llm`'s server module validates every tool input against the query's own payload schema before it reaches the browser; an input that fails is marked and answered with an error result rather than being asked.

---

## 8. Pages

A page is an HTML file: an import map plus component tags with attributes. Nothing else. Precisely, a page may contain only: the `<!doctype html>` declaration; `html`, `head` and `body`; `meta` and `title`; `link[rel=stylesheet]` whose `href` is under `/static/tokens/`; one `script[type=importmap]` whose JSON equals `vendor/vendor.json`'s importmap; `script[type=module][src]` whose `src` is a built component's browser entry, `view.js` or `fact.js`, under `/static/components/`, or the composer under `/static/composer/`, with no inline body; and custom-element tags (a hyphen in the tag name) with any attributes. Anything else — a `div`, a class, inline logic — fails the page check (section 11.2). The tags are the page's default composition; where a tag fills a role (7.3) and the page loads the composer, the composer (3.6) may mount a different implementation the user chose, in place, and a role's default tag needs only its own `view.js` loaded — the composer imports other members on demand. Five kinds, in increasing order of composition:

1. **Tokens page.** Shows the design tokens and the icons, so the visual vocabulary can be reviewed before anything uses it.
2. **Contracts page.** The event, command, and query vocabulary, drawn from the running components: each contract with its schema, who emits or answers it, who consumes or asks. This is where the shared language is reviewed.
3. **Components page.** Every component, built or planned, drawn from its manifest: kind, shape, what it emits and consumes, what it answers, what it owns, and the computed list of components it interacts with. This is where you stand in front of the slip-box and think about which notes could point at which. The components page is the stem page of `catalog`.
4. **Stem pages.** One per root component with its related components wired together: a fact component with its views (`notes` with editor, list, and reader; `conversations` with `chat-thread`, `chat-input` and `conversation-list`; `llm` with `settings-sheet`; `dock` with `dock-desk`; `settings` with `settings-sheet`; `books` with shelf, contents and reader; `subject` with the notes views that follow it), or a container view with the views it composes (`work-desk` with the tokens, contracts and components views). The `trace` stem page (`trace` with `trace-list`) shows the traffic actually observed on the bus this session. A stem page is the test bed for its root.
5. **App pages.** Things created so far composed around a purpose: a journal, a chat with the language model, a book reader, or combinations of these. An app page is a book: a path through the box. The product is the app page at `/` (`pages/index.html`); the pages under `/workshop/apps/` are testbeds for assembling components.

Pages are listed by the `pages` fact component, and `page-nav` is how a page links to the others: it groups its links by kind and shows none in the product profile (§12). A page declares its kind with `<meta name="kind" content="…">`, one of `tokens`, `contracts`, `components`, `stem`, `app`; `pages: list` returns pages in that order, then by path.

The contracts page and the components page show the same data in two arrangements. Neither is hand-written, so they cannot diverge.

---

## 9. How a component comes to exist

Because changing a contract is the expensive operation, contracts are decided before code.

1. Create the component's directory with a machine that declares only metadata, `status: planned`, and any new event or query schemas.
2. It appears on the components page and the contracts page. Review it there against its neighbours: does it consume events nobody emits, ask queries nobody answers, duplicate a fact someone already owns, or need a change to an existing contract?
3. Only when the contracts settle, write the actor, then the store or view, then the server module if any, then tests.
4. Add its browser entry and put it on a page: the entry is what makes it built.

A change to what the user sees is reviewed before it is live, because the product and the workshop run the same code. It is built behind an attribute the page must set, and set first only on a stem page; the product page (`pages/index.html`) gets the attribute once the user has approved it there, on the desk and in the phone preview.

Coding agents follow the same four steps. Step 2 is the human's, and the components page is where it happens.

---

## 10. Libraries

Each block maps to one small, mature library, vendored under `/vendor` and loaded through an import map. No build step: every change, browser or server, is visible on reload. Beside each library is what we lean on and what we do not, so that the intended use is unambiguous.

| Block | Library | Licence | We use | We do not use |
|---|---|---|---|---|
| View | Lit | BSD-3 | Templating (`html`); reactive properties, which turn tag attributes such as `name` and `follows` into state the view reacts to, which is what lets pages be pure declarations; shadow DOM, which isolates a view's styles so it can only be themed through tokens, the one thing that crosses a shadow boundary; the connected/disconnected lifecycle, where a view subscribes to and unsubscribes from the bus, so a removed tag leaves nothing behind; reactive controllers, as the home for "attach this actor's state to this view" | Decorators (need a build); Lit context or any cross-component sharing (that is the bus's job) |
| Rich editor | CodeMirror 6 + @replit/codemirror-vim | MIT | `EditorView`, a `StateField` and line decorations for `note-editor-cm6`: a three-level (Title/Heading/Subheading) buffer whose markers live only in the wire string, never in the marker-free document Vim edits; Vim normal mode; the theme keyed to tokens; mounted into the shadow root with the `root` option so style-mod stays off the document. And for `highlight-notes` a second document — the book's highlights composed into one, a quote line per note held fixed by an `EditorState.transactionFilter` while the comment lines under each are edited freely; `history` and `drawSelection`, no Vim; and for `highlight-notes-vim`, the Vim member of the role, the same document in Vim normal mode, where `dd` on a quote line removes the highlight | A markdown/@lezer grammar (levels are our own field, not parsed syntax); line numbers, the search panel, autocompletion |
| Actor | XState v5 | MIT | Machines as the actor definition, which is also where the manifest is read from; the actor system for mailboxes, one message at a time, and addressing by id; `fromPromise` for a fact component's calls to its own server module; `fromCallback` for a streamed reply pushed from that server module, its pieces arriving as internal messages (the model's answer in `llm`); the `inspect` hook for tracing | Spawning actors that talk to other components' actors directly; anything that bypasses the bus |
| Store (browser) | Dexie | Apache-2 | Tables and transactions, one database per fact component | Live queries (the bus is the reactivity); a shared database |
| Bus | native `EventTarget` | — | Delivery; everything else (routing, validation, correlation) is ours and small | — |
| Ids | ULID | MIT | Client-generated, sortable ids | Server-assigned ids |
| Server | FastAPI | MIT | One router per fact component, discovered by walking the components directory; `--reload` | A shared data layer |
| Store (server) | SQLite | public domain | One file per user per fact component | A shared schema |
| Backup | Litestream | Apache-2 | Continuous replication of every file | — |
| Schema (browser) | @cfworker/json-schema | MIT | Validating payloads in the browser against draft 2020-12, the validator constructed with the draft given explicitly, behind our `validate()` wrapper | A draft chosen implicitly |
| Schema (server) | Python `jsonschema` | MIT | Validating payloads server-side — a model's proposed tool input against the tool's payload schema before it reaches the browser (7.7) — and the schema compatibility check (section 11.2) when it arrives | — |
| Language model | `anthropic` | MIT | The official Python client in `llm`'s server module: streaming completions, tool use and prompt caching (7.7), one adapter file per provider behind our own neutral interface | Its tool runner or agent loop (the loop is ours, in `conversations`); any beta; any cross-provider wrapper |
| Secrets | `cryptography` | Apache-2 / BSD-3 | Fernet to encrypt the account's API key at rest in `llm`'s store, the key derived from `SESSION_SECRET` and a fixed label so no new `.env` entry is needed (7.7) | Storing a key in plaintext; a new secret in `.env` |
| Font | Inter | OFL-1.1 | One self-hosted variable file, all weights | Italic, until a view needs it |
| Icons | Phosphor Icons | MIT | Regular-weight path data, one icon at a time, copied verbatim from `@phosphor-icons/core` 2.1.1 `assets/regular/<name>.svg` (7.6) | The font, the web and react packages, other weights, the whole set |
| WebAuthn | py_webauthn | BSD-3 | The passkey ceremonies (registration and authentication options, and verifying the browser's response) in `session`'s server module | Cookies or sessions, which are `server/user.py`'s HMAC over the user id |
| Tests | Node's `node --test` and Playwright (WebKit, then Chromium) | MIT / Apache-2 | Browser tests per component under `tests/`, WebKit at task end and both engines before a push (11); Node tests for the bus under `bus/tests/`; not vendored, Playwright is located through `PLAYWRIGHT_MODULE` in the gitignored `.env`. Actors can also be imported in Node through `checks/register.mjs`, which resolves the import map the way the browser does. A WebAuthn ceremony is tested in Chromium only, through its virtual authenticator; WebKit covers the rendering. A test that forges a session cookie refuses to start unless `UNBLENT_DATA` names a throwaway data directory, which the check passes to the tests beside `UNBLENT_URL`, so a suite pointed by hand at the running server on :8080 stops before it writes into `data/` | A test framework |

Libraries are vendored as their official builds at pinned versions, copied verbatim with their licence and source map, and recorded in `vendor/vendor.json` with their source URLs, licences, and a sha256 per file. The vendor check (section 11.2) fails on any file that is unlisted, missing, altered, or whose source-map reference does not resolve.

Two pieces are wrapped behind our own small interfaces, because their surface is small and swapping is plausible: the **store** (Dexie now, could be SQLite in the browser) and the **bus** (`EventTarget` now, could be a worker). XState and Lit are not wrapped: they are the actor and view semantics, and a wrapper would be a thinner XState.

**Tracing.** The bus taps every routing decision (section 3.3): who emitted or asked what, who received it, who ignored it because their state does not handle it, what was held for an asker until its reply and released after (4.2), what was dropped for lack of a subscriber, refused for lack of a declaration, or never answered. The `trace` fact component keeps those records in memory since the page loaded, bridges tabs of the same origin over a `BroadcastChannel` so an inspector tab sees what an acting tab did, and prints one line per record to the console at debug level, so a person or an agent reading the console through Playwright has a complete, ordered transcript. `trace-list` shows the same record on the `trace` stem page. This is the primary debugging tool and it is meant to be used autonomously.

Deliberately not used: a global state store, a micro-frontend framework, a message broker, a bundler, any framework that wants to own the page.

---

## 11. Enforcement

The system is maintained by coding agents, so the rules are not advice. Every violation fails immediately, and one `check` command is the definition of done: `check.py --changed` is what must pass before a task ends, and the bare `check.py`, every static rule plus every test, is what must pass before a push.

The check has two phases: the fast phase (every static rule) runs after every edit, and the test phase follows it at two gates. The task-end gate is `check.py --changed` (paths derived from `git` against `HEAD`; `--only <components>` names them by hand): the fast phase plus the tests reachable from the changed components — their one-hop bus-interaction partners and the components that share a page with them — with browser tests in WebKit, and in Chromium only where a test exists for it alone (the WebAuthn ceremony). Any infrastructure change (`bus`, `store`, `checks`, `vendor`, `tokens`, the `server` entry, `.env`, or `requirements.txt`) still reaches every test. The push gate is the bare `check.py`: every test, WebKit then Chromium, run by the pre-push hook in `.githooks/`, so nothing is pushed red. The task-end gate so grows with the change, not with the system; what it trades is that a Chromium-only regression is found at push rather than at task end. Each phase has a time budget that does not grow with the system: the fast phase within one second in total, and every test within five seconds on its own. Exceeding a budget is itself a failure, naming the slowest rules or the slow test, so the fast phase stays fast enough to run constantly and a slow test is found by name rather than hidden in a total. One test phase runs at a time on a host: the check takes an exclusive lock before its tests and a second run waits for it, because a wall-clock budget means nothing while two runs share the cores. A test that uses more than half its budget is named in a warning, so a test with no headroom is found before load makes it fail.

### 11.1 Directory per component, front and back

```
components/
  notes/
    machine.js        actor definition; manifest is read from here
    store.js          IndexedDB cache + outbox, behind the store interface
    fact.js           browser entry: creates the actor with its inputs and mounts it on the bus
    events/           JSON Schema per event this component owns
    queries/          JSON Schema per query this component answers: { payload, reply, supersededBy }
    server/
      router.py       FastAPI router for /api/notes
      schema.sql      per-user SQLite schema and migrations
    tests/
  note-editor/
    machine.js
    view.js
    commands/         JSON Schema per command this component accepts
    tests/
  settings/
    machine.js
    store.js          localStorage, behind the store interface
    fact.js
```

The components tree sits inside a small repository-wide layout:

```
server/          FastAPI entry (named "server", not "app", so it never clashes with pages/workshop/apps/)
  user.py        the entry's user infrastructure: who the request is from and where their files live (UNBLENT_DATA overriding data/); a server module may import it
  tests/         HTTP tests for the entry; infrastructure like the bus, not a component. Never served
components/      one directory per component, as above
vendor/          vendored libraries and vendor.json (the manifest and the import map)
tokens/          tokens.css, base.css and icons.js, the document layer (7.4, 7.6)
pages/           the HTML pages (section 8): pages/index.html, the product, and pages/workshop/design|apps/<name>.html
checks/          check.py, the one check command; show.py, prints the components, contracts and pages the server reports (7.1); tests/ its own unit tests, never served
bus/             the bus (built once)
composer/        the composer (3.6), loaded once per page; tests/ never served
store/           the store interface; tests/ never served
deploy/          systemd unit, litestream.yml (section 5) and the rclone units that copy the files (section 5) and anything else the host needs; never served
data/            per-user SQLite files (section 5) and `books/`, the imported files, gitignored
.env             machine-specific settings and secrets (SESSION_SECRET, RP_ID, MAX_USERS), gitignored
```

Static serving is namespaced so the future app can own `/`:

| URL | Serves |
|---|---|
| `/static/vendor/…`, `/static/components/…`, `/static/tokens/…` | those directories, `Cache-Control: no-cache` |
| `/static/bus/…` | the bus, `Cache-Control: no-cache`; its `tests/` are never served |
| `/static/composer/…` | the composer, `Cache-Control: no-cache`; its `tests/` are never served |
| `/static/store/…` | the store interface, `Cache-Control: no-cache`; its `tests/` are never served |
| `/workshop/design/<name>` | `pages/workshop/design/<name>.html`, 404 if missing |
| `/workshop/apps/<name>` | `pages/workshop/apps/<name>.html`, 404 if missing |
| `/api/<component>/…` | that component's router (discovered by the walk) |
| `/` | `pages/index.html`, the product |

A component's `server/` (its Python server module) and `tests/` are never served: the static mount for `components/` 404s any path that dips into them, so source and tests never reach the browser.

Deleting a component is deleting one directory and its databases. Nothing else needs to change, and if it does, the checks say which contract was broken.

### 11.2 The checks

| Rule | Enforced by |
|---|---|
| Components never touch each other | Import check, JavaScript and Python: every import specifier is either a relative path that stays inside the component's own directory (no `..`), or a bare specifier the page's import map resolves — a vendored name from `vendor/vendor.json`, or `bus`, `store`, or `icons`. A server module may import the standard library, the packages named in `requirements.txt`, `server.user` (the entry's user infrastructure), or a relative module inside its own `server/`. The composer, like the bus, is infrastructure outside `components/`: a page may load it, and it may import a role member's `view.js` by its `/static/components/…/view.js` URL |
| Everything goes through the bus | Same check; there is no other importable channel |
| Events match their contract | The bus validates every emitted event against the schema registry at runtime and throws on unknown names or invalid payloads |
| Queries match their contract | The bus registers each answered query's schema at mount and validates payload and reply at runtime |
| Contracts are written down | Contract check: every declared emit has `events/<name>.json`, every answered query `queries/<name>.json`, every accepted command `commands/<name>.json`; each parses as JSON Schema with the draft stated; no schema file without its declaration or handler |
| Only declared events are emitted | The bus refuses an emit whose name is not in the emitter's declared list |
| Only fact components answer queries | The bus refuses to route a query to a view component |
| Replies land before what supersedes them | The bus holds a query's `supersededBy` events for the asker until the reply has landed, and refuses at mount a `supersededBy` naming an event the fact does not emit |
| Askers follow what they ask | Supersession check: every query schema has a `supersededBy` list of the fact's own events, and every asker of a query consumes every event that supersedes it |
| Secrets stay out of the trace | The bus replaces the value of any event or reply field whose schema marks it `x-secret` (7.2) with a fixed marker before the tap sees it, so no secret reaches the trace, the console, or another tab; the event delivered to the receiver still carries the real value |
| Only marked queries are tools | The bus lets an `asks` of `"*: tool"` reach a query only when that query's registered schema carries a `tool` entry (7.7); any other query is refused as an undeclared ask, and the contract check requires a query's `tool` entry to be a non-empty `description` and `label` |
| Contracts only grow | Schema compatibility check of the working tree against `HEAD`, over every `events/`, `queries/` and `commands/` schema: fails on a removed or renamed field, a new required field, a narrowed `type`, a removed `enum`/`const` value, a removed `oneOf`/`anyOf` branch, `additionalProperties` closing, or a schema file removed while its component remains; names the path inside the schema and the components affected, from the manifests |
| One owner per fact | Store check: a fact component may open only the database bearing its own name; view components open none |
| Pages contain no logic | Page check: only an import map and tags, and exactly one `meta[name=kind]` naming one of the five kinds of section 8 |
| Tokens only | Style check: views use no colour, spacing, size, or type value that is not a token, in both `css` templates and the inline `style` attributes of `html` templates. Size means any property that places or sizes a box: width, height, inset, grid tracks, border width. Percentages, `fr`, and unitless factors in `calc()` are relative and allowed |
| Icons are used and known | Icon check: every name in `tokens/icons.js` is used by some view as a literal `icon("name")`, and every `icon("name")` in a view exists. Names are literals in views, so the check stays static |
| Vendored code is what it claims | Vendor check: every file under `vendor/` is listed in `vendor.json` with a matching sha256, every listed file exists, and every `sourceMappingURL` resolves |
| Nothing fails in the browser | Browser tests fail on any console error, page error, failed request, or 4xx/5xx response while a page loads |
| A test owns its browser | Browser rule: the check preloads a hook that fails any test leaving a browser it launched open when it ends, closes that browser at once, and fails the run if a suite leaves one open, so a timed-out test cannot leak a browser into the next and exhaust the host |
| Manifests cannot be stale | There is nothing to keep in sync: they are read from the machine, and undeclared emits fail at runtime |
| Manifests are well-formed | Manifest check: every machine imports in Node, its id equals its directory name, `kind` and `emits` are present and valid, `shape` and `owns` are present on fact components only, `attributes` on view components only, and `status` is absent because it is derived |
| A component is one directory of known shape | Component check: `machine.js` present, no entries beyond `machine.js`, `view.js`, `fact.js`, `store.js`, `events/`, `queries/`, `commands/`, `server/`, `tests/`; a view has no `fact.js`, store, server or `queries/`, a fact has no `view.js`; `view.js` defines the element named after its directory; a component with a browser entry has tests |
| Pages compose only what exists | Page check: every custom element on a page is a built view whose `view.js` the page loads, every loaded `view.js` is used, and every loaded `fact.js` belongs to a fact component; the composer script is allowed, and a role's default tag needs only its own `view.js` loaded |
| Roles are coherent | Role check: every component declaring a role exposes the same contract (emits, asks, accepts, answers), so a swap cannot surprise a neighbour |
| The composer stays in its lane | Composer check: the composer changes only role-bearing elements, in place, and never `html`, `head`, or `title` |
| Only document facts write to the document | Document check: no file under `components/` writes to `document` (its root element, `body`, `head`, or `title`) except the `fact.js` of a component listed in section 7.5, and that one writes only its own `data-<name>` attribute |
| The layout is what the document says | Layout check: every top-level directory appears in the listing in 11.1 |
| The check stays fast | Time budget: the fast phase within one second in total, every test within five seconds on its own; exceeding either fails and names the slowest rules or the slow test |

The architecture document describes the rules; the checks are what make them real.

---

## 12. Constraints and known edges

- **No query between views.** If two views seem to need to talk, either one should emit an event the other listens to, or they are one view.
- **Ordering across components.** The bus delivers in order within a tab, but two components reacting to the same event finish in any order. The read-then-event race is closed by the hold (4.2): `note-reader` reacts to `note.selected` by querying `notes: read(id)`, and a `note.changed` that lands while that read is open is held for the reader and delivered right after the reply, in order, so the reader never adopts the old body and then misses the new one. What remains an edge is reactions to the *same* event finishing in any order: nothing may assume another component reacted first (section 4, fourth rule). A later change from elsewhere — another device's edit pulled by `notes`, long after the hold closed — is still caught by version comparison.
- **Remote-only facts fail offline.** That is by design: `llm`'s `complete` query replies at once with an error, and a failure that happens while an answer is arriving rides the turn to the chat through `completion.progressed`, where the user is looking, rather than through a separate event.
- **Three shared vocabularies.** The event registry, the design tokens and the icons are global schemas in disguise. All are kept small: events are additive-only, tokens are minimal, icons grow one glyph at a time, each approved by sight. All change only with permission, and all are reviewed on a page before use.
- **No cross-user features.** One database per user per component means the server never sees two users at once. For this app that is a feature.

- **One user per browser.** Signing in adopts everything cached anonymously in that browser, so `notes` enqueues its whole cache to the account; a second account on the same browser is not a goal.

- **A notice lives in its tab.** `notice-stack` consumes `session.refused`, `note.conflicted` and `note.refused` and shows them as dismissable notices; a conflict offers Keep mine, which re-emits `note.saved` (the view where the user acted, section 4) so the user's copy survives what `notes` otherwise drops. It holds notices only as UI state: after a reload the conflict, and the copy it carried, are gone, because `notes` does not yet keep conflicts as a queryable fact.

- **Tracing crosses tabs, not devices.** The trace bridges same-origin tabs in one browser; another device has its own.

- **Swapping composition.** The composer (3.6) changes which implementation fills a role, in place; the replaced actor unmounts cleanly. A swappable view keeps its dock slot because the dock layout identifies it by its role, not its tag — the one place `dock`/`dock-desk` must key on role. Whether that touches the `dock.changed` schema or stays internal is settled when the composer is built (§9 step 2).

- **Pages are per device.** A chapter is paginated for the reader's own size and type, so page numbers differ between devices; the shared position is a chapter and a block, and each device opens the page holding it.

- **Two profiles.** `settings` keeps one copy of the preferences per profile, `product` and `workshop`, and reports the active one. A page outside `/workshop/` is in `product` until the user switches; a workshop page is always `workshop`. `profile-switch` is the one door from the product into the workshop and is deliberately not a visible signifier: it appears on hover or focus. A phone preview left on in `workshop` still frames the product after switching back, until it is switched off in `workshop`.

- **A note's links.** A note carries `about`, a list of `{ kind, id }` naming what it is about: none, one or many. A `note.saved` without `about` leaves the list as it is; with it, replaces it, so unlinking is a save with a shorter list. A new note is linked to the subject (3.1) at creation, by the editor where it was written. A link to something since deleted is harmless: the note is still listed under all notes. Each link is an object so it can later carry a place inside its target. A link to a book may carry a `place` — the chapter, the content version of the book the numbers were counted in, and a start and an end, each a block and a character — and a `quote`: the exact text, with a little text before and after it. A note whose link has a place is a highlight: `book-reader` paints it, and the note's body is the comment on it. After a re-import the reader finds the quote again and saves the corrected place; a highlight whose quote is no longer in the book stays a note with its quote and its comment.

- **Following the subject.** With the `subject` attribute, `note-list` shows the notes about the subject — a note always belongs to the subject, so there is no switch to all notes — and a `note-editor` opens the most recently edited note about it whenever the subject changes, or an empty page. A pinned editor stays: it refuses a `note.selected` or `load` that names another note with `note.refused` until it is unpinned, so the note on screen never changes by surprise; one that names the note it already shows changes nothing and is not refused. The pin is UI state, kept in localStorage (3.1): it follows the browser, not the account. The editor also keeps, the same way, the titles of the subjects it has seen, so the About line can name a pinned note's book after a reload. With the `about-new` attribute, an editor holding a new note shows the subject in the About line, because that is what the note will be linked to at its first save; a keystroke made before the editor knows the subject is held until it does, so a new note is never saved without its link. With the `keeps-open` attribute, `note-list` also lists the note open in the editor when that note is not about the subject — a pinned note, or one still open after unpinning — in a row apart from the others, at the top, so the highlighted row is never missing; the list learns which note is open from `note.opened` and knows nothing about the pin.

- **Marking the subject.** With the `marks-subject` attribute, `dock-desk` shows a mark on the tab of the view that shows the subject, whether that tab is in front or not, with the subject's title as its hover text. The mark is an indicator and not a control. No marked tab means there is no subject. `dock-desk` learns the subject the same way any view does: it asks `subject: read` for the starting picture and follows `subject.changed`.

- **Which chat is open follows the subject.** `conversations` owns which chat is open, like `books` owns which book is open, because three views need it and a view cannot ask a view. When the subject changes, the open chat becomes the most recently updated chat about it, or none, and the panel shows an empty new chat. This is per device (5): each device may be looking at a different chat.

- **The text a chat starts with is filled once.** A chat keeps a `start`: the general instructions the conversation began with, written once, by the view where the user acted, when the chat is created. It never changes afterwards, so the provider's cache holds and the chat stays an honest record of what the model was told. `conversations` does not know what a prompt is; a specific request is what the user types, not part of `start`.

- **Chat settings follow the account.** Provider, model, thinking effort and cache lifetime are owned by `llm` and kept on its server, so they are the same on every device and apply to the next question in any chat; there is no per-chat copy. Today's device preferences (`settings`) stay on the device. Settings shows the two as sections named "This device" and "Your account".

- **Echo is a test provider.** A standing-in provider that echoes the conversation streams answers without a key or a network call, so tests and by-hand checks never spend money. It is offered as a choice in Settings only in the `workshop` profile; the server accepts it always, and an account left on Echo in the product sees it named "Echo (test)" with the real providers to switch to.

---

## 13. Vocabulary

- **Component**: one directory, one name, one concept or one way of looking at it; the unit of ownership. Front and back end together.
- **Fact component**: headless owner of a concept; emits when it changes, answers queries about it. Local-only, replicated, or remote-only.
- **View component**: a way of looking at or acting on a concept; owns only UI state.
- **Actor**: the deciding part of a component; a mailbox processed one message at a time.
- **View**: the visible, decision-free part of a view component.
- **Store**: a fact component's private persistence, wherever it lives.
- **Server module**: the server side of a fact component, in the same directory.
- **Outbox**: local changes not yet acknowledged by the server.
- **Bus**: the shared infrastructure that routes events, commands, and queries, and validates them.
- **Composer**: the shared infrastructure that mounts the user's chosen implementation for each role in place of the page's default, and re-swaps when the choice changes.
- **Role**: a name for a slot of interchangeable view implementations sharing a contract; the composer mounts the chosen one.
- **Event**: a broadcast fact, past tense, not persisted.
- **Command**: an addressed instruction; no reply.
- **Query**: an addressed question to a fact component; always a reply, matched by correlation id.
- **Manifest**: what a component emits, consumes, accepts, answers, and owns; read from its machine.
- **Stem**: a fact component together with its related views.
- **Page**: an HTML file, an import map and tags; tokens, contracts, components, stem, or app.
- **App**: the page kind that composes components around a purpose.
- **Subject**: what the user is working on: the thing shown by the view that was last in front on the stage among the views that show a thing, as a kind, an id, a title and the view that shows it; owned by `subject`, a derived fact.
- **Link**: one entry of a note's `about`, naming something the note is about.
- **Chat**: a conversation with the language model, owned by `conversations`; it holds its links (`about`), its `start`, and its turns.
- **Turn**: one message in a chat, immutable once finished — a user turn (text, and any results answering the tool calls before it) or an assistant turn (text, a status, and any tool calls).
- **Start**: the general instructions a chat begins with, written once when it is created and never changed (12).
- **Tool**: one of the system's own queries, opted in by its owner, that the model may ask during a chat; it only reads, never acts (7.7).

---

## 14. Directions

Where the product is heading. Nothing here is designed or built; each line is one sentence, and a proposal says how it leaves every line open.

- The side-dock chat, now being built, knowing more of what the reader is looking at: the open book, the chapter being read, and the highlight or note in focus.
- Every chat able to draw on the whole library — every book, note and highlight — so that what the reader marked and wrote shapes the answers.
- Chats linked to books, so a book shows its notes and its chats.
- One note linked to many books at once.
- Unlinking a note.
- A journal: the one book the user writes, a chapter per day, only the current day's chapter editable, with notes, highlights and chats beside it like any other book (sketch: `~/.claude/plans/journal-book.md`).
- A jump from a highlight to its passage, with one step back to the reading place.
- Making highlights from the keyboard, Vim style.
- Making highlights on a phone.
- The model in a chat looking things up by asking the queries fact components already answer, each one opted in by its owner and switched on by the user.
- Sending a note's text to the chat as the next message, so a note that holds a useful question can be used again with any book.
- A second model provider, OpenAI.
- A pinned chat that stays while the subject changes, learning what is open now from what is added at the end of the conversation, never from a change to its beginning.
- A command overlay opened from the keyboard, where the user types what they want (open a book, show a note, move a tab) and it is carried out through commands the views declare, each argument chosen from a list a fact provides (sketch: `~/.claude/plans/command-overlay.md`).
- A fast decision model such as Jev (typesafe.ai), which writes no text and picks one of up to 255 options or answers yes or no with a probability, for understanding a typed command in the overlay and for choosing among tools if they become many (sketch: `~/.claude/plans/command-overlay.md`).
- A switch in Highlights between all highlights and those of the current chapter.
- One tab for a list and the item picked from it, with a Back arrow, used for Books with Contents, Notes with Editor, and Chats with Chat, so each dock holds fewer tabs (sketch: `~/.claude/plans/list-then-item.md`).
- Settings opened from a gear button in the header beside the account button, not from a tab in the right dock, and the header buttons made about twice as large (sketch: `~/.claude/plans/settings-button.md`).
- A small shared editor kit beside the bus, the store and the icons, holding only what every CodeMirror editor repeats — the theme from tokens, the Vim cursor, switching Vim on and off — and never what one editor alone needs, such as the note editor's Title, Heading and Subheading levels; considered only after one "Vim keys" switch in Settings has replaced the Vim copy of each view (sketch: `~/.claude/plans/editor-kit.md`).
