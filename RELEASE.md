# YouTube Tab Parker 1.3.11

Every installation now uses the same extension ID as the Chrome Web Store version, `bhnabphdcdknjeebnmeikbdcncnfhdpf`. Tab Atelier 3.1.21 recognizes this ID directly. Parking behavior is unchanged.

**Upgrading an unpacked installation:** the extension ID changes once. Chrome then closes the parked tabs of the old installation and resets Tab Parker's settings.

1. In Tab Atelier, open the Video Inbox and choose **Update Tab Parker safely** → **Hold parked tabs**.
2. Remove the old Tab Parker in `chrome://extensions`, then load this version.
3. Choose **Restore parked tabs**. Tab Atelier moves them to the new ID with their titles and channels.
4. Set your loading mode and thumbnail preference again.

Without Tab Atelier, save your parked links before upgrading.

This release requires no new Chrome permissions.

1. Download the extension ZIP from Releases and extract it to a permanent folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted folder containing `manifest.json`. Pin the extension if you want its popup in the toolbar.

The download includes the MIT license. See the README for features and privacy details.
