let IS_PROD = false;
const server = IS_PROD ?
    "https://zoom-hdl2.onrender.com" :

    "http://localhost:8000"


export default server;