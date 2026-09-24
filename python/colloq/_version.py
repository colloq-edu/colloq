# Package version for hatchling: pyproject.toml reads the wheel version from
# here. release-please bumps the number in the release PR (by the marker at
# the end of the line), and scripts/pack.mts rewrites the file with the same
# text when packing. Do not edit by hand: `make version` checks the number
# against the root package.json.
__version__ = "0.4.1"  # x-release-please-version
