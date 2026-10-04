# Makes the branch `public`: one root commit holding the tracked files of
# HEAD, without the private planning notes, so the history of this repository
# (and what it says about the work) is not what gets published.
#
#   .\windows\scripts\make-public-branch.ps1            # from anywhere in the repository
#   .\windows\scripts\make-public-branch.ps1 -Message "Nook 0.1.0"
#
# What it does, and only this:
#   * lists the files tracked in HEAD, leaves out plans/ and anything that
#     .gitignore matches (a file added by force would otherwise slip through);
#   * builds the commit from a temporary index, so your working tree, your
#     current branch and your index are not touched;
#   * creates or moves the local branch `public` to that single commit, with no
#     parent.
# It never pushes. To publish, review the branch first:
#   git log --stat public; git ls-tree -r --name-only public
# then, from a place you are sure of: git push <remote> public:main
#
# Commit what you want published before running it: untracked and uncommitted
# files are not in HEAD and are left out.

param(
    [string]$Message = "Nook"
)

$ErrorActionPreference = "Stop"

$root = (git rev-parse --show-toplevel).Trim()
Set-Location $root

# Paths that never go public, as git pathspec prefixes.
$private = @("plans/", ".claude/", "_prive/")

$files = @(git ls-files -z) -join "" -split "`0" | Where-Object { $_ }
$keep = foreach ($f in $files) {
    if ($private | Where-Object { $f.StartsWith($_) }) { continue }
    git check-ignore -q -- $f
    if ($LASTEXITCODE -eq 0) { continue }
    $f
}

$tmpIndex = Join-Path ([IO.Path]::GetTempPath()) ("nook-public-index-" + [Guid]::NewGuid().ToString("N"))
try {
    $env:GIT_INDEX_FILE = $tmpIndex
    # The temporary index starts as HEAD's, then loses what is not kept.
    git read-tree HEAD
    foreach ($f in $files) {
        if ($keep -notcontains $f) { git rm --cached -q --ignore-unmatch -- $f }
    }
    $tree = (git write-tree).Trim()
}
finally {
    Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
    Remove-Item $tmpIndex -ErrorAction SilentlyContinue
}

$commit = (git commit-tree $tree -m $Message).Trim()
git branch -f public $commit

Write-Host "public -> $commit  ($(@($keep).Count) files, no parent). Nothing was pushed."
