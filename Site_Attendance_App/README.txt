SITE ATTENDANCE – face recognition time clock (web app for Android)
===================================================================

WHAT IT DOES
- One shared phone/tablet at the site entrance. Workers look at the camera, blink, and tap their punch:
  Morning Time In, Morning Time Out, Afternoon Time In, Afternoon Time Out, OT Time Out.
- Works offline after the first load. All data stays on the device.
- Excel report: Daily, Totals, Punch log, Corrections, Info sheets.

1) PUT IT ONLINE (once, about 5 minutes, free)
   The camera only works from an https:// link, so the folder must be hosted.
   Option A – Netlify:
     a. On a PC, unzip this file.
     b. Go to app.netlify.com/drop and sign up for a free account (so the site stays up).
     c. Drag the unzipped folder onto the page. You get a link like https://something.netlify.app
   Option B – GitHub Pages: create a repository, upload all the files (keep the "model" folder),
     then Settings > Pages > Deploy from branch "main".

2) INSTALL ON THE ANDROID KIOSK DEVICE
   a. Open the https link in Chrome. Allow camera access.
   b. Wait until the screen says "No workers enrolled yet" (the face models have loaded).
   c. Chrome menu (three dots) > "Add to Home screen" / "Install app".
   d. Open it from the home-screen icon. It now works without internet.
   e. Settings on the phone: keep it plugged in. Turn off battery saver for Chrome.
      Use Android "App pinning" so workers cannot leave the app.

3) FIRST SET-UP
   a. Tap Admin, PIN 1234, then change the PIN right away (Settings tab).
   b. Check the schedule (default AM 08:00–12:00, PM 13:00–17:00, OT after 17:00), grace minutes and OT rounding.
   c. Workers tab > "+ Enrol worker" for each person: ID, name, team, role, tick the consent box,
      tap "Capture face" and follow the prompts (straight, left, right, straight, chin up). Save.
      Enrol in the same light as the kiosk spot, without cap or sunglasses.

4) DAILY USE
   - Workers: look at the camera, blink slowly when asked, tap the highlighted punch.
   - Missed or wrong punch: Admin > Daily records > tap the cell > enter time and reason.
     Every change is logged in the Corrections sheet.
   - End of day: Admin > Export & backup > Download Excel AND Download backup.
     Send both to the engineer's laptop or Drive.
     IMPORTANT: if the phone is reset, lost, or Chrome data is cleared, records are gone unless backed up.

5) NEW OR REPLACEMENT DEVICE
   Install as in step 2, then Admin > Export & backup > Restore, and choose the latest backup file.

6) PRIVACY (Data Privacy Act, RA 10173)
   - Get each worker's written consent before enrolling (the app also asks for it).
   - Face data and photos stay on the device and in the backup files. Keep the backups private.
   - At project end: export the final report, then Settings > Erase all data, and delete old backups.

TIPS
- Recognition problems in bad light: Settings > Match strictness > Relaxed, or move the device to a brighter spot.
- If the blink check keeps failing: blink slowly. As a last resort it can be switched off in Settings,
  but then a photo of a worker could be used to clock them in.
