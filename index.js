require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const url = require('url');
const bcrypt = require('bcrypt');
const cookie = require('cookie');

// Проверка токена
if (!process.env.TELEGRAM_TOKEN) {
  console.error('ОШИБКА: Токен не найден в .env файле!');
  console.log('Проверьте:');
  console.log('1. Файл .env существует в папке проекта');
  console.log('2. Содержит строку TELEGRAM_TOKEN=ваш_токен');
  console.log('3. Файл .env добавлен в .gitignore');
  process.exit(1);
}

const PORT = 3000;
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: 'root1234',
    database: 'todolist',
};

async function queryDB(sql, params) {
    const connection = await mysql.createConnection(dbConfig);
    const [results] = await connection.execute(sql, params);
    await connection.end();
    return results;
}

async function authenticate(req) {
    const cookies = cookie.parse(req.headers.cookie || '');
    if (!cookies.sessionId) return null;
    
    try {
        const [user] = await queryDB(
            'SELECT u.id, u.username FROM users u JOIN sessions s ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > NOW()',
            [cookies.sessionId]
        );
        return user || null;
    } catch (error) {
        console.error('Authentication error:', error);
        return null;
    }
}

async function sendUserNotification(userId, message) {
    try {
        const [user] = await queryDB(
            'SELECT telegram_chat_id FROM users WHERE id = ?',
            [userId]
        );
        
        if (user.telegram_chat_id) {
            await bot.sendMessage(user.telegram_chat_id, message);
        }
    } catch (error) {
        console.error('Telegram notification error:', error);
    }
}

bot.on('message', (msg) => {
    if (msg.text === '/start') {
        bot.sendMessage(
            msg.chat.id,
            `Ваш Chat ID: <code>${msg.chat.id}</code>\nСкопируйте его и введите в приложении`,
            { parse_mode: 'HTML' }
        );
    }
});

async function handleRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const user = await authenticate(req);
    
    try {
        if (req.method === 'GET' && /\.(css|js|html)$/.test(parsedUrl.pathname)) {
            try {
                const content = await fs.promises.readFile(path.join(__dirname, parsedUrl.pathname));
                res.writeHead(200);
                res.end(content);
                return;
            } catch {
                res.writeHead(404);
                res.end('Not found');
                return;
            }
        }

        if (req.method === 'GET' && parsedUrl.pathname === '/login') {
            if (user) {
                res.writeHead(302, {'Location': '/'});
                res.end();
                return;
            }
            const html = await fs.promises.readFile(path.join(__dirname, 'login.html'), 'utf8');
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(html);
            return;
        }
        
        if (req.method === 'POST' && parsedUrl.pathname === '/login') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                const { username, password } = JSON.parse(body);
                const [user] = await queryDB('SELECT * FROM users WHERE username = ?', [username]);
                
                if (user && await bcrypt.compare(password, user.password_hash)) {
                    const sessionId = require('crypto').randomBytes(16).toString('hex');
                    await queryDB(
                        'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))',
                        [sessionId, user.id]
                    );
                    
                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        'Set-Cookie': cookie.serialize('sessionId', sessionId, {
                            httpOnly: true,
                            maxAge: 60 * 60 * 24,
                            path: '/'
                        })
                    });
                    res.end(JSON.stringify({success: true, username: user.username}));
                } else {
                    res.writeHead(401, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({success: false, error: 'Invalid credentials'}));
                }
            });
            return;
        }
        
        if (req.method === 'GET' && parsedUrl.pathname === '/register') {
            if (user) {
                res.writeHead(302, {'Location': '/'});
                res.end();
                return;
            }
            const html = await fs.promises.readFile(path.join(__dirname, 'register.html'), 'utf8');
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(html);
            return;
        }
        
        if (req.method === 'POST' && parsedUrl.pathname === '/register') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                const { username, password } = JSON.parse(body);
                
                if (!username || !password) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({success: false, error: 'Username and password are required'}));
                    return;
                }
                
                if (password.length < 6) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({success: false, error: 'Password must be at least 6 characters'}));
                    return;
                }
                
                try {
                    const passwordHash = await bcrypt.hash(password, 10);
                    await queryDB('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, passwordHash]);
                    res.writeHead(200, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({success: true}));
                } catch (error) {
                    if (error.code === 'ER_DUP_ENTRY') {
                        res.writeHead(400, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({success: false, error: 'Username already exists'}));
                    } else {
                        console.error('Registration error:', error);
                        res.writeHead(500, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({success: false, error: 'Registration failed'}));
                    }
                }
            });
            return;
        }
        
        if (req.method === 'GET' && parsedUrl.pathname === '/api/me') {
            if (!user) {
                res.writeHead(401, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({error: 'Unauthorized'}));
                return;
            }
            
            const [userData] = await queryDB(
                'SELECT username, telegram_chat_id FROM users WHERE id = ?',
                [user.id]
            );
            
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({
                username: userData.username,
                hasTelegram: !!userData.telegram_chat_id
            }));
            return;
        }
        
        if (req.method === 'POST' && parsedUrl.pathname === '/bind-telegram') {
            if (!user) {
                res.writeHead(401);
                return res.end('Unauthorized');
            }
            
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                const { telegramChatId } = JSON.parse(body);
                
                await queryDB(
                    'UPDATE users SET telegram_chat_id = ? WHERE id = ?',
                    [telegramChatId, user.id]
                );
                
                try {
                    await bot.sendMessage(
                        telegramChatId,
                        "✅ Ваш аккаунт успешно привязан к To-Do приложению!\n" +
                        "Теперь вы будете получать уведомления о задачах."
                    );
                } catch (error) {
                    console.error('Ошибка отправки уведомления:', error);
                }
                
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ success: true }));
            });
            return;
        }
        
        if (req.method === 'POST' && parsedUrl.pathname === '/unbind-telegram') {
            if (!user) {
                res.writeHead(401);
                return res.end('Unauthorized');
            }
            
            try {
                // Получаем chat_id перед отвязкой
                const [userData] = await queryDB(
                    'SELECT telegram_chat_id FROM users WHERE id = ?',
                    [user.id]
                );
                
                // Отвязываем Telegram
                await queryDB(
                    'UPDATE users SET telegram_chat_id = NULL WHERE id = ?',
                    [user.id]
                );
                
                // Отправляем уведомление в Telegram, если chat_id был
                if (userData && userData.telegram_chat_id) {
                    try {
                        await bot.sendMessage(
                            userData.telegram_chat_id,
                            "❌ Ваш аккаунт отвязан от To-Do приложения.\n" +
                            "Вы больше не будете получать уведомления."
                        );
                    } catch (error) {
                        console.error('Ошибка отправки уведомления:', error);
                    }
                }
                
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ success: true }));
            } catch (error) {
                console.error('Ошибка при отвязке Telegram:', error);
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
            }
            return;
        }
        
        if (req.method === 'POST' && parsedUrl.pathname === '/logout') {
            const cookies = cookie.parse(req.headers.cookie || '');
            if (cookies.sessionId) {
                await queryDB('DELETE FROM sessions WHERE id = ?', [cookies.sessionId]);
            }
            
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': cookie.serialize('sessionId', '', {
                    httpOnly: true,
                    expires: new Date(0),
                    path: '/'
                })
            });
            res.end(JSON.stringify({success: true}));
            return;
        }
        
        if (!user) {
            res.writeHead(302, {'Location': '/login'});
            res.end();
            return;
        }
        
        if (req.method === 'GET' && parsedUrl.pathname === '/') {
            const html = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
            const items = await queryDB('SELECT * FROM items WHERE user_id = ? ORDER BY id', [user.id]);
            
            const rows = items.map((item, index) => `
                <tr data-id="${item.id}">
                    <td>${index + 1}</td>
                    <td class="item-text">${item.text}</td>
                    <td>
                        <button class="edit-btn" onclick="startEdit(${item.id})">Edit</button>
                        <button class="delete-btn" onclick="deleteItem(${item.id})">×</button>
                    </td>
                </tr>
            `).join('');
            
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(html.replace('{{rows}}', rows));
            return;
        }
        
        if (req.method === 'POST' && parsedUrl.pathname === '/items') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                const { text } = JSON.parse(body);
                await queryDB('INSERT INTO items (text, user_id) VALUES (?, ?)', [text, user.id]);
                
                await sendUserNotification(user.id, `📝 Добавлена задача: "${text}"`);
                
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({success: true}));
            });
            return;
        }
        
        if (req.method === 'DELETE' && parsedUrl.pathname.startsWith('/items/')) {
            const id = parsedUrl.pathname.split('/')[2];
            const [item] = await queryDB('SELECT * FROM items WHERE id = ? AND user_id = ?', [id, user.id]);
            
            if (!item) {
                res.writeHead(403);
                return res.end('Forbidden');
            }
            
            await queryDB('DELETE FROM items WHERE id = ?', [id]);
            
            await sendUserNotification(user.id, `❌ Удалена задача: "${item.text}"`);
            
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({success: true}));
            return;
        }
        
        if (req.method === 'PUT' && parsedUrl.pathname.startsWith('/items/')) {
            const id = parsedUrl.pathname.split('/')[2];
            const [item] = await queryDB('SELECT * FROM items WHERE id = ? AND user_id = ?', [id, user.id]);
            
            if (!item) {
                res.writeHead(403);
                return res.end('Forbidden');
            }
            
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                const { text } = JSON.parse(body);
                await queryDB('UPDATE items SET text = ? WHERE id = ?', [text, id]);
                
                await sendUserNotification(user.id, `✏️ Обновлена задача: "${text}"`);
                
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({success: true}));
            });
            return;
        }
        
        res.writeHead(404);
        res.end('Not found');
    } catch (error) {
        console.error(error);
        res.writeHead(500);
        res.end('Server error');
    }
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));