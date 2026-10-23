# Privacy

This note covers Unblent for Mac. The hosted web app at app.unblent.com is a separate
service and is not described here.

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

Nothing else leaves your Mac. There is no analytics, no crash reporting and no
advertising. The font, the icons and every library are inside the app, and
*Meditations*, the book on the shelf at first start, comes with the app; none of them
is downloaded.
