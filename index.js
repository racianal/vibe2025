const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const { parse } = require('querystring');
const cookie = require('cookie');

const PORT = 3000;
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'todolist',
};

// Сессии (в памяти)
const sessions = {};

// Проверка аутентификации
function isAuthenticated(req) {
    const cookies = cookie.parse(req.headers.cookie || '');
    return sessions[cookies.sessionId] !== undefined;
}

// Получение текущего пользователя
function getCurrentUser(req) {
    const cookies = cookie.parse(req.headers.cookie || '');
    return sessions[cookies.sessionId];
}

// Генерация HTML строк
async function getHtmlRows(userId) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute(
            'SELECT id, text FROM items WHERE user_id = ?',
            [userId]
        );
        await connection.end();
        
        return rows.map((item, index) => `
            <tr>
                <td>${index + 1}</td>
                <td>${item.text}</td>
                <td>
                    <button class="edit-btn" onclick="editItem(${item.id})">Edit</button>
                    <button class="delete-btn" onclick="deleteItem(${item.id})">Delete</button>
                </td>
            </tr>
        `).join('');
    } catch (error) {
        console.error('Error getting rows:', error);
        return '';
    }
}

// Обработка POST данных
function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => resolve(JSON.parse(body)));
    });
}

// Основной обработчик
async function handleRequest(req, res) {
    try {
        // Статический контент
        if (req.url === '/styles.css') {
            const css = await fs.readFile(path.join(__dirname, 'styles.css'), 'utf8');
            res.writeHead(200, {'Content-Type': 'text/css'});
            res.end(css);
            return;
        }

        // Аутентификация
        if (req.url === '/login' && req.method === 'POST') {
            const data = await parseBody(req);
            
            try {
                const connection = await mysql.createConnection(dbConfig);
                const [users] = await connection.execute(
                    'SELECT * FROM users WHERE username = ?',
                    [data.username]
                );
                await connection.end();
                
                if (users.length === 0 || !await bcrypt.compare(data.password, users[0].password)) {
                    res.writeHead(401, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: 'Invalid credentials' }));
                    return;
                }
                
                // Создание сессии
                const sessionId = Math.random().toString(36).substring(2, 15);
                sessions[sessionId] = users[0].id;
                
                res.writeHead(200, {
                    'Set-Cookie': cookie.serialize('sessionId', sessionId, {
                        httpOnly: true,
                        maxAge: 60 * 60 * 24 * 7 // 1 week
                    }),
                    'Content-Type': 'application/json'
                });
                res.end(JSON.stringify({ success: true }));
            } catch (error) {
                console.error('Login error:', error);
                res.writeHead(500);
                res.end('Server error');
            }
            return;
        }
        
        if (req.url === '/register' && req.method === 'POST') {
            const data = await parseBody(req);
            
            try {
                const connection = await mysql.createConnection(dbConfig);
                const [existing] = await connection.execute(
                    'SELECT * FROM users WHERE username = ?',
                    [data.username]
                );
                
                if (existing.length > 0) {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ error: 'Username already exists' }));
                    return;
                }
                
                const hashedPassword = await bcrypt.hash(data.password, 10);
                await connection.execute(
                    'INSERT INTO users (username, password) VALUES (?, ?)',
                    [data.username, hashedPassword]
                );
                await connection.end();
                
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ success: true }));
            } catch (error) {
                console.error('Registration error:', error);
                res.writeHead(500);
                res.end('Server error');
            }
            return;
        }
        
        if (req.url === '/logout' && req.method === 'POST') {
            const cookies = cookie.parse(req.headers.cookie || '');
            delete sessions[cookies.sessionId];
            
            res.writeHead(200, {
                'Set-Cookie': cookie.serialize('sessionId', '', {
                    expires: new Date(0)
                }),
                'Content-Type': 'application/json'
            });
            res.end(JSON.stringify({ success: true }));
            return;
        }
        
        // Страница задач
        if (req.url === '/todo') {
            if (!isAuthenticated(req)) {
                res.writeHead(302, { 'Location': '/' });
                res.end();
                return;
            }
            
            try {
                const userId = getCurrentUser(req);
                const html = await fs.readFile(path.join(__dirname, 'todo.html'), 'utf8');
                const processedHtml = html.replace('{{rows}}', await getHtmlRows(userId));
                
                res.writeHead(200, {'Content-Type': 'text/html'});
                res.end(processedHtml);
            } catch (error) {
                console.error('Todo page error:', error);
                res.writeHead(500);
                res.end('Server error');
            }
            return;
        }
        
        // Работа с задачами
        if (req.url.startsWith('/items')) {
            if (!isAuthenticated(req)) {
                res.writeHead(401);
                res.end('Unauthorized');
                return;
            }
            
            const userId = getCurrentUser(req);
            
            if (req.method === 'POST') {
                const data = await parseBody(req);
                
                try {
                    const connection = await mysql.createConnection(dbConfig);
                    await connection.execute(
                        'INSERT INTO items (text, user_id) VALUES (?, ?)',
                        [data.text, userId]
                    );
                    await connection.end();
                    
                    res.writeHead(200, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ success: true }));
                } catch (error) {
                    console.error('Add item error:', error);
                    res.writeHead(500);
                    res.end('Server error');
                }
                return;
            }
            
            const itemId = req.url.split('/')[2];
            if (!itemId) {
                res.writeHead(400);
                res.end('Bad request');
                return;
            }
            
            if (req.method === 'DELETE') {
                try {
                    const connection = await mysql.createConnection(dbConfig);
                    await connection.execute(
                        'DELETE FROM items WHERE id = ? AND user_id = ?',
                        [itemId, userId]
                    );
                    await connection.end();
                    
                    res.writeHead(200, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ success: true }));
                } catch (error) {
                    console.error('Delete item error:', error);
                    res.writeHead(500);
                    res.end('Server error');
                }
                return;
            }
            
            if (req.method === 'PUT') {
                const data = await parseBody(req);
                
                try {
                    const connection = await mysql.createConnection(dbConfig);
                    await connection.execute(
                        'UPDATE items SET text = ? WHERE id = ? AND user_id = ?',
                        [data.text, itemId, userId]
                    );
                    await connection.end();
                    
                    res.writeHead(200, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({ success: true }));
                } catch (error) {
                    console.error('Edit item error:', error);
                    res.writeHead(500);
                    res.end('Server error');
                }
                return;
            }
        }
        
        // Главная страница
        if (req.url === '/') {
            if (isAuthenticated(req)) {
                res.writeHead(302, { 'Location': '/todo' });
                res.end();
            } else {
                const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
                res.writeHead(200, {'Content-Type': 'text/html'});
                res.end(html);
            }
            return;
        }
        
        // 404
        res.writeHead(404);
        res.end('Not found');
    } catch (error) {
        console.error('Server error:', error);
        res.writeHead(500);
        res.end('Internal server error');
    }
}

// Запуск сервера
const server = http.createServer(handleRequest);
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));