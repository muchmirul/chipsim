import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'test/ui',timeout:60000,use:{baseURL:'http://127.0.0.1:8000',headless:true,viewport:{width:1440,height:1000}},webServer:{command:'npm start',url:'http://127.0.0.1:8000',reuseExistingServer:true},reporter:'list'});
