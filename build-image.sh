#!/bin/bash
# Builds a flashable Raspberry Pi OS image with Serial Killer Terminal Server pre-provisioned
# to install and start itself on first boot. Run this on macOS (uses hdiutil
# to mount just the FAT32 boot partition -- the ext4 root partition is never
# touched from the Mac side).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
SOURCE_IMG="$BUILD_DIR/raspios-lite-arm64.img"
OUTPUT_IMG="$BUILD_DIR/terminalserver-pi.img"
IMG_URL="https://downloads.raspberrypi.com/raspios_lite_arm64_latest"

mkdir -p "$BUILD_DIR"

if [ ! -f "$SOURCE_IMG" ]; then
  echo "==> Downloading latest Raspberry Pi OS Lite (arm64)..."
  XZ_PATH="$BUILD_DIR/raspios-lite-arm64.img.xz"
  curl -L --fail -o "$XZ_PATH" "$IMG_URL"
  echo "==> Decompressing..."
  python3 -c "
import lzma, shutil
with lzma.open('$XZ_PATH') as f_in, open('$SOURCE_IMG', 'wb') as f_out:
    shutil.copyfileobj(f_in, f_out, length=16*1024*1024)
"
else
  echo "==> Using existing $SOURCE_IMG"
fi

echo "==> Copying working image..."
cp "$SOURCE_IMG" "$OUTPUT_IMG"

echo "==> Building application tarball..."
APP_TAR="$BUILD_DIR/terminalserver-app.tar.gz"
rm -f "$APP_TAR"
tar -czf "$APP_TAR" \
  --exclude='node_modules' \
  --exclude='build' \
  --exclude='build-image.sh' \
  --exclude='.DS_Store' \
  -C "$SCRIPT_DIR" \
  server.js package.json lib webui provisioning

DEVICE=""
MOUNT_POINT=""

cleanup() {
  if [ -n "$MOUNT_POINT" ] && mount | grep -q "$MOUNT_POINT"; then
    diskutil unmount "$MOUNT_POINT" >/dev/null 2>&1 || true
  fi
  if [ -n "$DEVICE" ]; then
    hdiutil detach "$DEVICE" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "==> Attaching image..."
ATTACH_OUT=$(hdiutil attach -imagekey diskimage-class=CRawDiskImage -nomount "$OUTPUT_IMG")
echo "$ATTACH_OUT"
DEVICE=$(echo "$ATTACH_OUT" | awk '/FDisk_partition_scheme/{print $1}')
BOOT_PART=$(echo "$ATTACH_OUT" | awk '/Windows_FAT_32/{print $1}')

if [ -z "$BOOT_PART" ]; then
  echo "FATAL: could not find the FAT32 boot partition in the attached image" >&2
  exit 1
fi

echo "==> Mounting boot partition ($BOOT_PART)..."
diskutil mount "$BOOT_PART"
MOUNT_POINT=$(diskutil info "$BOOT_PART" | grep "Mount Point" | sed 's/.*Mount Point: *//')
echo "    mounted at $MOUNT_POINT"

echo "==> Enabling OS-level SSH (port 22, for normal Pi admin access)..."
touch "$MOUNT_POINT/ssh"

echo "==> Injecting first-boot provisioning..."
cp "$APP_TAR" "$MOUNT_POINT/terminalserver-app.tar.gz"
cp "$SCRIPT_DIR/provisioning/firstrun.sh" "$MOUNT_POINT/firstrun.sh"
chmod +x "$MOUNT_POINT/firstrun.sh"

CMDLINE_FILE="$MOUNT_POINT/cmdline.txt"
CMDLINE=$(cat "$CMDLINE_FILE")
# Strip any previous injection first, so this script is safely re-runnable.
CMDLINE=$(echo "$CMDLINE" | sed \
  -e 's| systemd.run=[^ ]*||' \
  -e 's| systemd.run_success_action=[^ ]*||' \
  -e 's| systemd.unit=kernel-command-line.target||')
CMDLINE="$CMDLINE systemd.run=/boot/firmware/firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target"
printf '%s\n' "$CMDLINE" > "$CMDLINE_FILE"

echo "==> cmdline.txt now reads:"
cat "$CMDLINE_FILE"
echo

echo "==> Unmounting..."
diskutil unmount "$MOUNT_POINT"
MOUNT_POINT=""
hdiutil detach "$DEVICE"
DEVICE=""
trap - EXIT

echo "==> Compressing final image..."
gzip -f -k "$OUTPUT_IMG"

echo
echo "Done. Flashable image:"
echo "  $OUTPUT_IMG"
echo "  $OUTPUT_IMG.gz (compressed, for easier transfer)"
