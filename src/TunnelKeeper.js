import R from 'ramda';

export default function TunnelKeeper() {
  let tunnels = {};

  function add(id, tunnel) {
    tunnels = R.assoc(id, tunnel, tunnels);
  }

  function remove(id) {
    tunnels = R.dissoc(id, tunnels);
  }

  function find(id) {
    return tunnels[id] || null;
  }

  function count() {
    return R.keys(tunnels).length;
  }

  return {add, remove, find, count};
}
