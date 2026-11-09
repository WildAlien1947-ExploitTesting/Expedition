const express = require('express');
const path = require('path');
const app = express();

// Define the network port (default to 3000)
const PORT = process.env.PORT || 3000;

app.use('/scramjet', express.static(path.join(__dirname, 'node_modules/@mercuryworkshop/scramjet/dist')));
app.use('/controller', express.static(path.join(__dirname, 'node_modules/@mercuryworkshop/scramjet-controller/dist')));
app.use(express.static(path.join(__dirname, 'dist')));
app.use(express.static(path.join(__dirname, 'public')));

// Fallback route: serve index.html for the home page request
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
