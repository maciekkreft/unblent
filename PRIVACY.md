# Privacy

This note covers Unblent for Mac and, in the last section, the website unblent.com. The
hosted web app at app.unblent.com is a separate service and is not described here.

## Where your data lives

Your books, highlights, notes and journal are stored on your Mac, in
`~/Library/Application Support/Unblent`. The app's window also keeps a working copy in
`~/Library/WebKit/com.unblent.app`, and its logs are in
`~/Library/Logs/com.unblent.app`. There is no account, no sync and no online backup.
`brew uninstall --zap unblent` deletes all of these folders.

The app runs a small server on your Mac that only the Mac itself can reach
(`127.0.0.1`, port 47321). Other computers on your network cannot connect to it.

## What the app sends over the network

**The update check.** Each time Unblent starts, it asks GitHub whether a newer version
exists. It requests one file:

    https://github.com/maciekkreft/unblent/releases/latest/download/latest.json

The request carries no information about you, your books or your notes. It does not
include your Unblent version or any identifier. Like any web request, it shows GitHub
your IP address, and it names the updater in its `User-Agent` header
(`tauri-plugin-updater/2.14.0`). GitHub's privacy statement applies to it.

If `latest.json` names a newer version, the app downloads that version
(`Unblent.app.tar.gz`, from the same GitHub release) in the background, then asks you
to *Restart to update* or *Later*. Nothing is installed until you choose
*Restart to update*.

**Links in a book.** A book may contain links to web pages. Unblent never opens them by
itself, and an image a book points to on the internet is left out. If you click such a
link, that web page opens in your own browser, not in Unblent.

**Chats.** With Ollama, the default, a chat goes only to Ollama on your own Mac
(`localhost`, or the address you set in Settings), so it stays on your Mac. If you choose
Anthropic in Settings and enter your own API key, each question is sent to Anthropic
together with the chat so far and whatever the chat looked up in your books, notes and
journal to answer it. Anthropic's privacy policy applies to it, and the key is stored
encrypted on your Mac.

Nothing else leaves your Mac. There is no analytics, no crash reporting and no
advertising. The font, the icons and every library are inside the app, and
*Meditations*, the book on the shelf at first start, comes with the app; none of them
is downloaded.

## This website

The website unblent.com is separate from the app, and it does keep a log of its visits.
For every page or file it serves, the site's own server writes down the time, the
address asked for (including a `?ref=` that says which link you came from), your IP
address, and the headers your browser sent: its name and version, your system, your
languages and the page you came from. The site is served through Cloudflare, which adds
your country and city as it estimates them from your IP address, and which also sees
every request.

A small script on the page also reports, once, when you leave it: how long the page was
open, how far you scrolled, which parts you saw, which links you clicked, your screen
and window size, your language, time zone and light or dark setting, and how fast the
page loaded. It sets no cookie and no identifier, so one visit cannot be linked to
another.

This is used to count visits, to see which links bring people and to tell people from
robots. It stays in a file on the site's own server, is shared with no one and is not
sent to any analytics or advertising service.

The email form for news of the AI features sends your address to Kit (kit.com), which
sends the mails; Kit's privacy statement applies to it. Nothing else on the page loads
from another site.
