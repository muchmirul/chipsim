#!/bin/sh
# Explicit optional build. No downloads or compiler invocation on trace import.
set -eu
if [ "$#" -ne 2 ]; then
  echo 'Usage: sh scripts/build-hdl-debug.sh NEW_PREFIX NEW_BUILD_DIRECTORY' >&2
  echo 'Requires: Node, Python 3, curl, tar, sha256sum, make, gcc/g++, GNAT, autoconf, gperf, flex, bison.' >&2
  exit 2
fi
recipe_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -- "$1"
debug_prefix=$(CDPATH= cd -- "$1" && pwd)
mkdir -- "$2"
debug_build=$(CDPATH= cd -- "$2" && pwd)
cd "$debug_build"
curl --fail --location --proto '=https' --tlsv1.2 https://codeload.github.com/steveicarus/iverilog/tar.gz/refs/tags/v12_0 -o iverilog.tar.gz
curl --fail --location --proto '=https' --tlsv1.2 https://codeload.github.com/ghdl/ghdl/tar.gz/refs/tags/v4.1.0 -o ghdl.tar.gz
echo 'a68cb1ef7c017ef090ebedb2bc3e39ef90ecc70a3400afb4aa94303bc3beaa7d  iverilog.tar.gz' | sha256sum -c -
echo '0aab531b45a6613b0918f3ac6ec717b8acfad051d1abb1c39eb7490590c7a324  ghdl.tar.gz' | sha256sum -c -
tar -xzf iverilog.tar.gz
tar -xzf ghdl.tar.gz
python3 "$recipe_root/extensions/hdl-debug/iverilog/apply.py" "$debug_build/iverilog-12_0"
python3 "$recipe_root/extensions/hdl-debug/ghdl/apply.py" "$debug_build/ghdl-4.1.0"
cd "$debug_build/iverilog-12_0"
sh autoconf.sh > "$debug_build/iverilog-build.log" 2>&1
./configure --prefix="$debug_prefix/iverilog" >> "$debug_build/iverilog-build.log" 2>&1
make -j "${CHIPSIM_BUILD_JOBS:-2}" >> "$debug_build/iverilog-build.log" 2>&1
make install >> "$debug_build/iverilog-build.log" 2>&1
cd "$debug_build/ghdl-4.1.0"
./configure --prefix="$debug_prefix/ghdl" --disable-libghdl > "$debug_build/ghdl-build.log" 2>&1
make -j "${CHIPSIM_BUILD_JOBS:-2}" >> "$debug_build/ghdl-build.log" 2>&1
make install >> "$debug_build/ghdl-build.log" 2>&1
mkdir "$debug_prefix/licenses"
cp "$debug_build/iverilog-12_0/COPYING" "$debug_prefix/licenses/iverilog-COPYING"
cp "$debug_build/ghdl-4.1.0/COPYING.md" "$debug_prefix/licenses/ghdl-COPYING.md"
node "$recipe_root/extensions/hdl-debug/manifest.mjs" "$debug_prefix"
echo "Instrumented tools installed in $debug_prefix. Set CHIPSIM_HDL_DEBUG_TOOLS to this directory. Build sources and logs are in $debug_build."
