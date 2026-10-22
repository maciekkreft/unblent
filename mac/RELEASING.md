# Releasing Unblent for Mac

A release is made by pushing a version tag such as `v0.1.0`. GitHub then builds the
app on a Mac, publishes it on the repository's Releases page, and updates the Homebrew
cask. A push to `main` never reaches users. Every tag does: there is no test channel.

## Once: the update key

The app installs an update only if it was signed with your private update key.

1. On the Mac, with the Tauri command line installed (`cargo install tauri-cli --locked`),
   run `cargo tauri signer generate -w ~/unblent-updater.key`. It asks for a password
   and writes two files: `unblent-updater.key` (private) and `unblent-updater.key.pub`
   (public).
2. Save the private key file and its password in your password manager. If the key is
   lost, installed copies can never be updated again; users would have to download a
   new copy by hand.
3. On GitHub, in the repository's Settings → Secrets and variables → Actions, add two
   secrets: `TAURI_SIGNING_PRIVATE_KEY`, holding the whole content of the private key
   file, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, holding its password.
4. Put the whole content of the `.pub` file into `mac/src-tauri/tauri.conf.json`, in
   place of `REPLACE_WITH_PUBLIC_KEY`, and commit it. Then delete the key files from
   the Mac's home folder.

Never change `identifier` (`com.unblent.app`) in `tauri.conf.json`: macOS keeps the
app's stored pages and settings under it, and a new one would look like a new app.

## Once: the Homebrew tap

1. Create a public repository named `homebrew-tap` under `maciekkreft`, with a folder
   `Casks`.
2. Create a fine-grained personal access token that can write the contents of that one
   repository only.
3. Add it to the `unblent` repository's Actions secrets as `TAP_TOKEN`.

Without `TAP_TOKEN` the release still works; only the cask is not updated.
Users then install with `brew install --cask maciekkreft/tap/unblent`.

## Each release

1. Make sure `main` holds what should ship and the checks pass.
2. Tag and push: `git tag v0.1.0 && git push origin v0.1.0`. A version may carry a
   suffix for a trial, such as `v0.1.0-rc1`; it is published to users all the same.
3. Watch the run under the repository's Actions tab. It takes about 15 minutes.
4. On success the release holds `Unblent.dmg`, `Unblent.app.tar.gz`, its `.sig`
   and `latest.json`, and the cask in the tap names the new version.

The version comes from the tag, not from `tauri.conf.json`. A tag must be higher
than the last one, or installed copies will not see it as an update.

## What users see

- **First install.** The app is not notarised by Apple, so the first open shows that
  macOS cannot check it. The user opens System Settings → Privacy & Security and
  clicks Open Anyway, once.
- **Updates.** When the app starts and a newer release exists, it downloads it in the
  background and asks "Version X is ready", with Restart to update or Later. Nothing
  is installed until they choose Restart to update. Their books and notes stay in
  `~/Library/Application Support/Unblent` and are not touched by an update. An
  updated app does not ask for Open Anyway again.
- **Homebrew.** The cask says the app updates itself, so a plain `brew upgrade` leaves
  it alone and `brew upgrade --greedy` updates it. `brew uninstall --zap unblent` deletes
  the user's books and notes too; a plain `brew uninstall` does not.

## Building on your own Mac

`bash mac/build-local.sh` builds the same app without GitHub and without the update
key, and prints where `Unblent.dmg` is. Its log is `mac/build-local.log`.
