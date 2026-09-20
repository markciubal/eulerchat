/**
 * Add the chat rooms to a server you already have.
 *
 * `createEulerChat` binds no port and reads no argv. It answers for its own
 * paths and stays silent on everything else, so your routes are untouched.
 *
 *   node examples/2-add-chat-to-your-app.mjs
 */
import http from 'node:http';
import { createEulerChat, World, seed } from 'eulerchat/app';

const app = http.createServer((req, res) => {
  if (req.url === '/') res.writeHead(200).end('your app');
  else if (!res.headersSent) res.writeHead(404).end('not found');
});

const chat = createEulerChat({
  world: seed(new World()),  // or your own, built with addSubject/addUser/join
  server: app,               // attaches to yours
  mount: '/chat',            // lives under a path; omit for the root
});

app.listen(8080, () => {
  console.log('your app       http://localhost:8080/');
  console.log('the chat rooms http://localhost:8080/chat/');
});

// chat.world        membership, messages, diagramFor(), atlasFor()
// chat.sessions     who is connected, and on what
// chat.notifications preferences, unread counts, backlog
// chat.handleRequest serve the client yourself, behind your own middleware
// chat.close()
