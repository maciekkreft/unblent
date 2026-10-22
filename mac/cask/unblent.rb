# The cask in github.com/maciekkreft/homebrew-unblent (Casks/unblent.rb), kept here so it
# is reviewed with the app. It always installs the newest release; the app updates itself.
cask "unblent" do
  version :latest
  sha256 :no_check

  url "https://github.com/maciekkreft/unblent/releases/latest/download/Unblent.dmg",
      verified: "github.com/maciekkreft/unblent/"
  name "Unblent"
  desc "Reader for ePub books with notes, highlights and a journal"
  homepage "https://unblent.com"

  # No auto_updates and no livecheck: Homebrew's audit refuses both on a :latest cask,
  # and brew upgrade already leaves a :latest cask alone unless --greedy is given.
  depends_on arch: :arm64
  depends_on macos: ">= :monterey"

  app "Unblent.app"

  # Only `brew uninstall --zap` runs this, and it deletes the user's books and notes.
  zap trash: [
    "~/Library/Application Support/Unblent",
    "~/Library/Application Support/com.unblent.app",
    "~/Library/Caches/com.unblent.app",
    "~/Library/HTTPStorages/com.unblent.app",
    "~/Library/Logs/com.unblent.app",
    "~/Library/Preferences/com.unblent.app.plist",
    "~/Library/Saved Application State/com.unblent.app.savedState",
    "~/Library/WebKit/com.unblent.app",
  ]
end
