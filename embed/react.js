/**
 * The map as a React component.
 *
 * Deliberately thin. All of the work is in `mountMap`, which knows nothing
 * about React, so this is the adapter and not the implementation — and the
 * same thirty lines would serve Vue or Svelte or a plain page.
 *
 *   import { EulerMap } from 'eulerchat/react';
 *
 *   <EulerMap
 *     users={db.users}
 *     interests={db.userInterests}
 *     focus={currentUser.id}
 *     view="atlas"
 *     onSelectRoom={(room) => open(room.key)}
 *   />
 *
 * React is a peer dependency and an optional one: nothing else in the package
 * imports this file, so a project that never touches it never needs React.
 */

import { createElement, useEffect, useRef } from 'react';
import { mountMap } from './mount.js';

/**
 * @param {object} props
 * @param {Array} [props.users]       rows, as your application already has them
 * @param {Array} [props.interests]   the join table, if interests live apart
 * @param {object} [props.columns]    which column means what; guessed if omitted
 * @param {object} [props.data]       already-adapted data, instead of rows
 * @param {string} [props.focus]      whose neighbourhood to show
 * @param {'map'|'atlas'} [props.view]
 * @param {number} [props.novelty]    0 goes deeper, 1 reaches further out
 * @param {string[]} [props.subjects] show exactly these, rather than choosing
 * @param {(room: object) => void} [props.onSelectRoom]
 * @param {(room: object|null) => void} [props.onHoverRoom]
 * @param {(view: object) => void} [props.onRender]
 */
export function EulerMap({
  users,
  interests,
  columns,
  data,
  focus,
  view = 'map',
  novelty,
  subjects,
  mold,
  padding,
  onSelectRoom,
  onHoverRoom,
  onRender,
  ...rest
}) {
  const host = useRef(null);
  const map = useRef(null);
  // Callbacks are read through a ref so that a parent re-rendering with a new
  // inline arrow does not tear the map down and rebuild it.
  const handlers = useRef({});
  handlers.current = { onSelectRoom, onHoverRoom, onRender };

  useEffect(() => {
    if (!host.current) return undefined;
    map.current = mountMap(host.current, {
      users,
      interests,
      columns,
      data,
      focus,
      view,
      novelty,
      subjects,
      mold,
      padding,
      onSelect: (room) => handlers.current.onSelectRoom?.(room),
      onHover: (room) => handlers.current.onHoverRoom?.(room),
      onRender: (drawn) => handlers.current.onRender?.(drawn),
    });

    return () => {
      map.current?.destroy();
      map.current = null;
    };
    // Mounted once; everything after is an update, so that redrawing does not
    // mean rebuilding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    map.current?.update({
      users,
      interests,
      columns,
      data,
      focus,
      view,
      novelty,
      subjects,
      mold,
      padding,
    });
  }, [users, interests, columns, data, focus, view, novelty, subjects, mold, padding]);

  return createElement('div', {
    ref: host,
    style: { width: '100%', height: '100%', minHeight: 320, ...(rest.style ?? {}) },
    ...rest,
  });
}

export { mountMap, viewFor } from './mount.js';
export default EulerMap;
