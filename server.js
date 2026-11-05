const express = require('express');
const path = require('path');
const app = express();

// Define the network port (default to 3000)
const PORT = process.env.PORT || 3000;

// Tell Express to serve all static assets from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Fallback route: serve index.html for the home page request
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
