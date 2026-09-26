#!/usr/bin/env bash
# Builds the on-phone helper (acm-helper.jar) and embeds it in src/helper-jar.js.
# Needs a JDK (11+) and Google's r8 jar: R8_JAR=/path/to/r8.jar ./helper/build.sh
set -euo pipefail
cd "$(dirname "$0")"
: "${R8_JAR:?set R8_JAR to the Google r8.jar (https://dl.google.com/android/maven2/com/android/tools/r8/)}"
rm -rf build && mkdir -p build/classes build/dex
javac --release 8 -nowarn -d build/classes $(find stubs src -name '*.java')
java -cp "$R8_JAR" com.android.tools.r8.D8 --release --min-api 26 --output build/dex --lib build/classes build/classes/acm/*.class
(cd build/dex && zip -q -X ../acm-helper.jar classes.dex)
node embed.cjs
