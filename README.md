# IMOO PWA deployment

## Render without GitHub

1. Extract the ZIP and open a terminal in the folder containing Dockerfile.
2. Install and start Docker. Create a private Docker Hub repository named imoo-pwa.
3. Replace YOUR_DOCKERHUB_USER below and run:

   docker login
   docker build --platform linux/amd64 -t YOUR_DOCKERHUB_USER/imoo-pwa:v1 .
   docker push YOUR_DOCKERHUB_USER/imoo-pwa:v1

4. In Render, choose New > Web Service > Existing Image. Enter docker.io/YOUR_DOCKERHUB_USER/imoo-pwa:v1 and add your Docker Hub credentials with pull access.
5. Under Environment Variables, set BOT_API_KEY to your onboarding webhook key and GEMINI_API_KEY to your Gemini API key. The Dockerfile already sets BOT_CHANNEL=PROTOTYPE, HOST=0.0.0.0, PORT=10000 and NODE_ENV=production.
6. Deploy and open the HTTPS onrender.com URL. Enter a UAT mobile number and tap Continue to check its status. Next, try an authorized test document and check the result.

Render documentation for prebuilt images: https://render.com/docs/deploying-an-image

## Install on a device

- Android Chrome: open the HTTPS URL, then select Install app or Add to Home screen.
- iPhone Safari: open the HTTPS URL, then select Share > Add to Home Screen.
- Desktop Chrome or Edge: use the install icon in the address bar or the browser menu.

## Local Windows test

In Command Prompt, from this folder, run:

    npm install
    set "BOT_API_KEY=YOUR_ONBOARDING_KEY"
    set "GEMINI_API_KEY=YOUR_GEMINI_KEY"
    npm start

Open http://127.0.0.1:3002/.

## UAT access

A mobile number alone does not prove ownership. Keep this build on restricted UAT or use synthetic merchant records until you have merchant authentication for production. Both upstream APIs must be reachable by the host. The configured sample evidence URL is still used in the upstream payload where an image URL is needed.
