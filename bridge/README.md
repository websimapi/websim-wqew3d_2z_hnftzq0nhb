# Websim Nativefier Bridge

This Node.js application acts as a local bridge between your Websim page and the `nativefier` command-line tool. It listens for build requests from your browser client and executes them on your local machine.

## Prerequisites

- [Node.js](https://nodejs.org/) (Version 18.x or newer is recommended)
- `npm` (comes with Node.js)

## Setup and Running

1.  **Get your Project ID and Creator Token:**
    *   Go to your project page on Websim.
    *   Click on the **"Settings"** tab.
    *   Go to the **"API Access"** section.
    *   You will find your `Project ID` and `Creator Secret Token` there. You'll need these for the final step. **Keep your secret token private!**

2.  **Unzip this project folder** to a location of your choice on your computer (e.g., your Desktop or Downloads folder).

3.  **Open a terminal or command prompt** and navigate into the unzipped `websim-nativefier-bridge` directory.

    *On Windows:* Open the folder, right-click inside it, and choose "Open in Terminal" or "Open PowerShell window here".
    *On Mac/Linux:* Open your Terminal application and use the `cd` command.
    ```sh
    # Example:
    cd ~/Downloads/websim-nativefier-bridge
    ```

4.  **Install the dependencies.** This will download `nativefier` and other required packages. This might take a few minutes. If you see warnings, you can usually ignore them.

    ```sh
    npm install
    ```

5.  **Run the server with your credentials.** Replace `YOUR_PROJECT_ID` and `YOUR_CREATOR_TOKEN` with the values you got from the Websim settings page.

    ```sh
    npm start -- YOUR_PROJECT_ID YOUR_CREATOR_TOKEN
    ```
    
    **Example:**
    `npm start -- prj-abcdef123456 abc-this-is-a-secret-token-xyz`


You should see a message saying `Websim connection established. Bridge is active.`.

**That's it!** Keep this terminal window open. Go back to your Websim page in your browser. The status on the webpage should change from "Disconnected" to "Connected" within about 10 seconds. If it doesn't, refresh the page and double-check your credentials.

