# The template for Casks/unblent.rb in github.com/maciekkreft/homebrew-tap. The release
# workflow (.github/workflows/release.yml) fills in version and sha256 on every release.
cask "unblent" do
  version "0.1.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/maciekkreft/unblent/releases/download/v#{version}/Unblent.dmg",
      verified: "github.com/maciekkreft/unblent/"
  name "Unblent"
  desc "Reader for ePub books with notes, highlights and a journal"
  homepage "https://unblent.com"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app updates itself after asking the user.
  auto_updates true
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
