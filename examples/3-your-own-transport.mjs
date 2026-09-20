/**
 * Use the room semantics without the websockets.
 *
 * The world holds no connections. Delivery is a question about membership and
 * it answers with people; turning people into bytes is your business — email,
 * push, a queue, a game loop.
 *
 *   node examples/3-your-own-transport.mjs
 */
import { World, Notifications } from 'eulerchat/app';

const world = new World();
for (const subject of ['entomology', 'mycology', 'biology']) world.addSubject(subject);

const ana = world.addUser('ana');
const bo = world.addUser('bo');
world.setFunnel(ana, 1);          // joining also joins the field above
world.setFunnel(bo, 1);
world.join(ana, 'entomology');    // -> entomology, biology
world.join(bo, 'mycology');       // -> mycology, biology

// Who should hear this? User ids, no sockets in sight.
console.log('a post in biology reaches:', world.audienceFor(['biology']).length, 'people');
console.log('a post in entomology reaches:', world.audienceFor(['entomology']).length);

// And what is worth interrupting them for, delivered however you like.
const notify = new Notifications(world);
notify.onNotify((userId, note) => {
  console.log(`  [${note.level}] -> ${world.profiles.get(userId)?.name}: ${note.title}`);
  return false; // not delivered, so it is kept until they are back
});

world.post(bo, ['biology'], 'anyone else in the wider field?');
console.log('ana missed:', notify.drain(ana).length, 'notification(s)');
notify.close();
