/* =========================================================
 *  果趣订单 - 轻量级圆形物理引擎 (自包含, 无外部依赖)
 *  - 重力 / 边界约束 / 圆-圆碰撞 (基于位置修正的迭代求解)
 *  - 支持拖拽 (kinematic, invMass=0) 推开其它水果
 * ========================================================= */

let __bodyId = 0;

class Body {
  constructor(x, y, r, type, opts = {}) {
    this.id = ++__bodyId;
    this.x = x;
    this.y = y;
    this.px = x;          // 上一帧位置 (verlet 风格速度推导)
    this.py = y;
    this.vx = 0;
    this.vy = 0;
    this.r = r;
    this.type = type;     // 水果种类索引
    this.special = opts.special || null; // 'rainbow' | 'bomb' | 'slice' | null
    this.dragging = false;
    this.removed = false;
    this.spawnT = 0;      // 入场动画计时
    this.angle = (Math.random() - 0.5) * 0.4;
    this.scale = 0.1;     // 出生缩放动画
  }
  get invMass() {
    return this.dragging ? 0 : 1;
  }
}

class World {
  constructor(bounds) {
    this.bounds = bounds; // {x, y, w, h}  开口朝上的盒子
    this.bodies = [];
    this.gravity = 2400;  // px/s^2
    this.iterations = 6;  // 碰撞迭代次数
    this.restitution = 0.05;
    this.friction = 0.92;
    this.wallPad = 0;
  }

  setBounds(b) { this.bounds = b; }

  add(body) { this.bodies.push(body); return body; }

  remove(body) {
    body.removed = true;
  }

  clearRemoved() {
    this.bodies = this.bodies.filter(b => !b.removed);
  }

  count() {
    return this.bodies.length;
  }

  step(dt) {
    if (dt > 0.033) dt = 0.033; // 限制最大步长, 防止穿透
    const b = this.bounds;

    // 1) 积分 (半隐式欧拉)
    for (const o of this.bodies) {
      o.spawnT += dt;
      if (o.scale < 1) o.scale = Math.min(1, o.scale + dt * 6);
      if (o.dragging) {
        // 拖拽体: 朝目标点平滑移动, 速度由位移推导
        const tx = o.targetX, ty = o.targetY;
        o.vx = (tx - o.x) / Math.max(dt, 0.001);
        o.vy = (ty - o.y) / Math.max(dt, 0.001);
        o.x = tx; o.y = ty;
        continue;
      }
      o.vy += this.gravity * dt;
      o.vx *= this.friction ** (dt * 60 / 60);
      o.x += o.vx * dt;
      o.y += o.vy * dt;
    }

    // 2) 约束求解 (多次迭代)
    for (let it = 0; it < this.iterations; it++) {
      this.solveCollisions();
      this.solveBounds();
    }

    // 3) 从位置反推速度, 让碰撞修正反映到速度上 (轻微)
    // (这里保持简单, 速度已在积分阶段维护)
  }

  solveBounds() {
    const b = this.bounds;
    for (const o of this.bodies) {
      if (o.dragging) {
        // 拖拽时也限制在盒子内 (允许略微超出顶部)
        o.x = Math.max(b.x + o.r, Math.min(b.x + b.w - o.r, o.x));
        o.y = Math.min(b.y + b.h - o.r, o.y);
        o.y = Math.max(b.y - o.r * 1.5, o.y);
        continue;
      }
      // 左右墙
      if (o.x - o.r < b.x) { o.x = b.x + o.r; o.vx *= -this.restitution; }
      if (o.x + o.r > b.x + b.w) { o.x = b.x + b.w - o.r; o.vx *= -this.restitution; }
      // 底
      if (o.y + o.r > b.y + b.h) {
        o.y = b.y + b.h - o.r;
        o.vy *= -this.restitution;
        o.vx *= 0.8;
      }
    }
  }

  solveCollisions() {
    const arr = this.bodies;
    const n = arr.length;
    // 简单 O(n^2) — 水果数量较少 (<80) 可接受
    for (let i = 0; i < n; i++) {
      const a = arr[i];
      for (let j = i + 1; j < n; j++) {
        const c = arr[j];
        let dx = c.x - a.x;
        let dy = c.y - a.y;
        let d2 = dx * dx + dy * dy;
        const rsum = a.r + c.r;
        if (d2 >= rsum * rsum) continue;
        let d = Math.sqrt(d2) || 0.0001;
        const overlap = rsum - d;
        let nx = dx / d, ny = dy / d;
        const ima = a.invMass, imc = c.invMass;
        const imSum = ima + imc;
        if (imSum === 0) continue;
        const corr = overlap / imSum;
        a.x -= nx * corr * ima;
        a.y -= ny * corr * ima;
        c.x += nx * corr * imc;
        c.y += ny * corr * imc;
        // 速度交换 (轻微弹性)
        if (!a.dragging && !c.dragging) {
          const rvx = c.vx - a.vx;
          const rvy = c.vy - a.vy;
          const vn = rvx * nx + rvy * ny;
          if (vn < 0) {
            const jimp = -(1 + this.restitution) * vn / imSum;
            a.vx -= jimp * nx * ima;
            a.vy -= jimp * ny * ima;
            c.vx += jimp * nx * imc;
            c.vy += jimp * ny * imc;
          }
        }
      }
    }
  }

  // 找出与 start 同类型且相互接触的连通分量
  connectedSame(start, tol = 8) {
    const wildOk = (b) => b.special === 'rainbow';
    const matchType = start.type;
    const visited = new Set([start.id]);
    const comp = [start];
    const stack = [start];
    const touch = (a, c) => {
      const dx = c.x - a.x, dy = c.y - a.y;
      const rr = a.r + c.r + tol;
      return dx * dx + dy * dy <= rr * rr;
    };
    while (stack.length) {
      const cur = stack.pop();
      for (const o of this.bodies) {
        if (o.removed || visited.has(o.id)) continue;
        const sameType = o.type === matchType || wildOk(o) || (cur.special === 'rainbow');
        if (!sameType) continue;
        if (touch(cur, o)) {
          visited.add(o.id);
          comp.push(o);
          stack.push(o);
        }
      }
    }
    return comp;
  }

  // 半径范围内的所有 body
  inRadius(x, y, radius) {
    const out = [];
    for (const o of this.bodies) {
      if (o.removed) continue;
      const dx = o.x - x, dy = o.y - y;
      if (dx * dx + dy * dy <= radius * radius) out.push(o);
    }
    return out;
  }

  // 命中测试: 返回最近的 body
  pick(x, y) {
    let best = null, bestD = Infinity;
    for (const o of this.bodies) {
      if (o.removed) continue;
      const dx = o.x - x, dy = o.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= o.r * o.r && d2 < bestD) { best = o; bestD = d2; }
    }
    return best;
  }
}

window.Body = Body;
window.World = World;
