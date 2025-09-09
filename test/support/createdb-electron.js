import { app } from 'electron';
import createdb from './createdb.js';

createdb(function () {
    setTimeout(function () {
        app.quit();
    }, 20000);
});