/**
 * The map in a React application.
 *
 * Point it at the tables you already have. No server, no adapter layer, no
 * loop against our API — the column names are guessed, and a `novelty` column
 * steers what each person gets shown towards the familiar or the unfamiliar.
 */
import { useState } from 'react';
import { EulerMap } from 'eulerchat/react';

// Whatever your application already holds.
const users = [
  { id: 1, username: 'ana', novelty: 0.1 },   // show me more of what I know
  { id: 2, username: 'bo', novelty: 0.9 },    // show me somewhere new
  { id: 3, username: 'cy' },                  // no preference stored: the middle
];

const userInterests = [
  { user_id: 1, interest: 'entomology' },
  { user_id: 1, interest: 'mycology' },
  { user_id: 2, interest: 'entomology' },
  { user_id: 2, interest: 'poetry' },
  { user_id: 3, interest: 'theory of entomology' },  // becomes entomology
];

export default function Communities({ currentUserId }) {
  const [room, setRoom] = useState(null);
  const [view, setView] = useState('map');

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', height: 520 }}>
      <EulerMap
        users={users}
        interests={userInterests}
        focus={currentUserId}
        view={view}
        onSelectRoom={setRoom}
      />

      <aside>
        <button onClick={() => setView(view === 'map' ? 'atlas' : 'map')}>
          {view === 'map' ? 'see the atlas' : 'see the map'}
        </button>

        {room ? (
          <p>
            <strong>{room.subjects.join(' ∩ ')}</strong>
            <br />
            {room.population} {room.population === 1 ? 'person' : 'people'}
            {room.member ? ' · you are here' : ' · join to take part'}
          </p>
        ) : (
          <p>Pick a region on the map.</p>
        )}
      </aside>
    </div>
  );
}

/*
 * If the columns are not guessable, say which is which:
 *
 *   <EulerMap
 *     users={rows}
 *     columns={{ id: 'uuid', name: 'profile.displayName', subjects: 'tags' }}
 *   />
 *
 * If you would rather not pass rows at all, `viewFor(data, { focus })` returns
 * the same numbers with nothing drawn, and `mountMap(element, options)` is the
 * same component without React.
 */
