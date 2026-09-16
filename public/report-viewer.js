'use strict';

const parameters = new URLSearchParams(location.search);
const artifact = parameters.get('artifact') || '';
const title = parameters.get('title') || 'pytest-report.html';
const report = document.getElementById('report');

document.title = title;
report.title = title;
report.src = artifact;
