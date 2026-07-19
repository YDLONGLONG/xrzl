// 辅助函数

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randomChoice(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function getSeatedPlayers(room) {
  return Array.from(room.players.values()).filter(p => p.seat !== -1);
}

function getAlivePlayers(room) {
  return Array.from(room.players.values()).filter(p => p.isAlive && p.seat !== -1);
}

function getDeadPlayers(room) {
  return Array.from(room.players.values()).filter(p => p.isDead);
}

function getPlayerById(room, id) {
  return room.players.get(id) || null;
}

function getAliveNeighbors(room, player) {
  const seats = room.seats;
  const total = seats.length;
  const seatNum = player.seat;
  const neighbors = [];

  // 找左边存活邻居
  for (let i = 1; i < total; i++) {
    const leftIdx = (seatNum - i + total) % total;
    const left = seats[leftIdx];
    if (left && left.isAlive) {
      neighbors.push(left);
      break;
    }
  }

  // 找右边存活邻居
  for (let i = 1; i < total; i++) {
    const rightIdx = (seatNum + i) % total;
    const right = seats[rightIdx];
    if (right && right.isAlive) {
      neighbors.push(right);
      break;
    }
  }

  return neighbors;
}

module.exports = {
  shuffle,
  randomChoice,
  getSeatedPlayers,
  getAlivePlayers,
  getDeadPlayers,
  getPlayerById,
  getAliveNeighbors
};
