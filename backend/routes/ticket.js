const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');
const path = require('path');
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage });
const fs = require('fs');

const { createTicket } = require('../models/ticketModel');
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { getRepliesByTicketId, addReply } = require('../models/replyModel');

// 티켓 첨부파일 삭제
router.delete('/files/ticket/:filename', verifyToken, requireAdmin, async (req, res) => {
  const { filename } = req.params;

  try {
    // 1. DB에서 삭제
    await pool.query(`DELETE FROM ticket_files WHERE filename = $1`, [filename]);

    // 2. 실제 파일 삭제
    const filePath = path.join(__dirname, '..', 'uploads', filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({ message: '파일 삭제 완료' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '파일 삭제 실패' });
  }
});

// 댓글 첨부파일 삭제
router.delete('/files/reply/:filename', verifyToken, requireAdmin, async (req, res) => {
  const { filename } = req.params;

  try {
    await pool.query(`DELETE FROM ticket_reply_files WHERE filename = $1`, [filename]);

    const filePath = path.join(__dirname, '..', 'uploads', filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({ message: '댓글 파일 삭제 완료' });
  } catch (err) {
    res.status(500).json({ error: '댓글 파일 삭제 실패' });
  }
});

// 내 티켓별 미확인 관리자 댓글 수
router.get('/my/unread-counts', verifyToken, async (req, res) => {
  const userId = req.user.id;

  try {
    // 각 티켓에 대해 마지막 확인 시간과 관리자 댓글 비교
    const result = await pool.query(`
      SELECT
        t.id AS ticket_id,
        COUNT(r.*) FILTER (
          WHERE u.role = 'admin'
          AND (tr.last_read_at IS NULL OR r.created_at > tr.last_read_at)
        ) AS unread_count
      FROM tickets t
      LEFT JOIN ticket_replies r ON t.id = r.ticket_id
      LEFT JOIN users u ON r.author_id = u.id
      LEFT JOIN ticket_reads tr ON t.id = tr.ticket_id AND tr.user_id = $1
      WHERE t.customer_id = $1
      GROUP BY t.id
    `, [userId]);

    res.json(result.rows); // [{ ticket_id: 1, unread_count: 2 }, ...]
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '미확인 댓글 수 조회 실패' });
  }
});

// 고객 댓글 알림 확인
router.get('/admin/unread-counts', verifyToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        t.id AS ticket_id,
        COUNT(r.*) FILTER (
          WHERE u.role = 'customer'
          AND (tr.last_read_at IS NULL OR r.created_at > tr.last_read_at)
        ) AS unread_count
      FROM tickets t
      LEFT JOIN ticket_replies r ON t.id = r.ticket_id
      LEFT JOIN users u ON r.author_id = u.id
      LEFT JOIN ticket_reads tr ON t.id = tr.ticket_id AND tr.user_id = $1
      GROUP BY t.id
    `, [req.user.id]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '관리자 미확인 댓글 수 조회 실패' });
  }
});

// 관리자 댓글 읽음 처리
router.post('/:id/read', verifyToken, async (req, res) => {
  const ticketId = req.params.id;
  const userId = req.user.id;

  try {
    await pool.query(`
      INSERT INTO ticket_reads (ticket_id, user_id, last_read_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (ticket_id, user_id)
      DO UPDATE SET last_read_at = NOW()
    `, [ticketId, userId]);

    res.json({ message: '읽음 처리 완료' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '읽음 처리 실패' });
  }
});

// 내 티켓 목록 (고객)
router.get('/my', verifyToken, async (req, res) => {
  const customer_id = req.user.id;
  const { status, urgency, keyword } = req.query;

  let query = `SELECT * FROM tickets WHERE customer_id = $1`;
  const params = [customer_id];
  let index = 2;

  if (status) {
    query += ` AND status = $${index++}`;
    params.push(status);
  }
  if (urgency) {
    query += ` AND urgency = $${index++}`;
    params.push(urgency);
  }
  if (keyword) {
    query += ` AND title ILIKE $${index++}`;
    params.push(`%${keyword}%`);
  }

  query += ` ORDER BY created_at DESC`;

  try {
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: '티켓 목록 조회 실패' });
  }
});

// 모든 티켓 목록 (관리자)
router.get('/', verifyToken, requireAdmin, async (req, res) => {
  const { status, urgency, keyword } = req.query;

  let query = `
    SELECT t.*, u.email AS customer_email, u.company_name
    FROM tickets t
    JOIN users u ON t.customer_id = u.id
    WHERE 1=1`;
  const params = [];
  let index = 1;

  if (status) {
    query += ` AND t.status = $${index++}`;
    params.push(status);
  }
  if (urgency) {
    query += ` AND t.urgency = $${index++}`;
    params.push(urgency);
  }
  if (keyword) {
    query += ` AND t.title ILIKE $${index++}`;
    params.push(`%${keyword}%`);
  }

  query += ` ORDER BY t.created_at DESC`;

  try {
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: '전체 티켓 조회 실패' });
  }
});

// 티켓 상세 정보 + 댓글 + 첨부파일
router.get('/:id', verifyToken, async (req, res) => {
  const ticketId = req.params.id;

  try {
    // 1. 티켓 정보
    const ticketRes = await pool.query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
    if (ticketRes.rows.length === 0) return res.status(404).json({ message: '티켓 없음' });
    const ticket = ticketRes.rows[0];

    // ✅ 2. 티켓 첨부파일 정보 추가
    const fileRes = await pool.query(
      `SELECT filename, originalname FROM ticket_files WHERE ticket_id = $1`,
      [ticketId]
    );
    ticket.files = fileRes.rows;

    // 3. 댓글 + 첨부파일
    const replies = await getRepliesByTicketId(ticketId);

    res.json({ ticket, replies });
  } catch (err) {
    res.status(500).json({ error: '티켓 상세 조회 실패' });
  }
});

// 댓글 추가
router.post('/:id/replies', verifyToken, upload.array('files', 5), async (req, res) => {
  const ticketId = req.params.id;
  const { message } = req.body;
  const author_id = req.user.id;
  
  if (!message && req.files.length === 0) {
    return res.status(400).json({ message: '내용 또는 파일 중 하나는 필요합니다.' });
  }

  try {
    const replyRes = await pool.query(
      `INSERT INTO ticket_replies (ticket_id, author_id, message)
       VALUES ($1, $2, $3) RETURNING id`,
      [ticketId, author_id, message]
    );
    const replyId = replyRes.rows[0].id;

    // 파일 저장
    for (const file of req.files) {
      const fixedOriginalName = Buffer.from(file.originalname, 'latin1').toString('utf8'); //PostgreSql 한글 깨짐 처리
      await pool.query(
        `INSERT INTO ticket_reply_files (reply_id, filename, originalname)
         VALUES ($1, $2, $3)`,
        [replyId, file.filename, fixedOriginalName]
      );
    }

    res.status(201).json({ message: '댓글 등록 완료', reply_id: replyId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '댓글 등록 실패' });
  }
});

// 댓글 수정
router.put('/:ticketId/replies/:replyId', verifyToken, async (req, res) => {
  const { message } = req.body;
  const { ticketId, replyId } = req.params;
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT * FROM ticket_replies WHERE id = $1 AND ticket_id = $2 AND author_id = $3`,
      [replyId, ticketId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(403).json({ error: '수정 권한이 없습니다.' });
    }

    await pool.query(
      `UPDATE ticket_replies SET message = $1, updated_at = NOW() WHERE id = $2`,
      [message, replyId]
    );

    res.json({ message: '댓글 수정 완료' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '댓글 수정 실패' });
  }
});

// 댓글 삭제
router.delete('/:ticketId/replies/:replyId', verifyToken, async (req, res) => {
  const { ticketId, replyId } = req.params;
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT * FROM ticket_replies WHERE id = $1 AND ticket_id = $2 AND author_id = $3`,
      [replyId, ticketId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(403).json({ error: '삭제 권한이 없습니다.' });
    }

    await pool.query(`DELETE FROM ticket_replies WHERE id = $1`, [replyId]);

    res.json({ message: '댓글 삭제 완료' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '댓글 삭제 실패' });
  }
});

// 티켓 생성
router.post('/', verifyToken, upload.array('files', 5), async (req, res) => {
  const { title, description, urgency, product } = req.body;
  const customer_id = req.user.id;

  try {
    const result = await pool.query(
      `INSERT INTO tickets (title, description, urgency, product, customer_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [title, description, urgency, product, customer_id]
    );
    const ticketId = result.rows[0].id;

    // 파일 정보 저장
    const files = req.files;
    for (const file of files) {
      const fixedOriginalName = Buffer.from(file.originalname, 'latin1').toString('utf8'); //PostgreSql 한글 깨짐 처리
      await pool.query(
        `INSERT INTO ticket_files (ticket_id, filename, originalname)
         VALUES ($1, $2, $3)`,
        [ticketId, file.filename, fixedOriginalName]
      );
    }

    res.status(201).json({ message: '티켓 생성 완료', ticket_id: ticketId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '티켓 생성 실패' });
  }
});

// 관리자: 티켓 상태 변경
router.put('/:id/status', verifyToken, requireAdmin, async (req, res) => {
  const ticketId = req.params.id;
  const { status } = req.body;

  const allowed = ['접수', '진행중', '답변 완료', '종결'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ message: '유효하지 않은 상태입니다.' });
  }

  try {
    const result = await pool.query(
      'UPDATE tickets SET status = $1 WHERE id = $2 RETURNING *',
      [status, ticketId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: '티켓을 찾을 수 없습니다.' });
    }
    
    res.json({ 
      message: '상태 변경 완료',
      ticket: result.rows[0]
    });
  } catch (err) {
    console.error('상태 변경 오류:', err);
    res.status(500).json({ error: '상태 변경 실패' });
  }
});

module.exports = router;