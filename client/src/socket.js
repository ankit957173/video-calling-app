import { io } from "socket.io-client";

// Connect to the same host/port the page was served from.
// Vite's proxy forwards /socket.io → localhost:5000 on the server side,
// so this works whether the browser is on localhost or a mobile on the LAN.
const socket = io({ autoConnect: false });

export default socket;
