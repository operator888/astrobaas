import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';

export const GET: APIRoute = async () => {
  try {
    await LocalDB.init();
    
    const categories = await LocalDB.getCategories();
    
    return ApiResponseBuilder.success(categories, 'Categories retrieved successfully');
  } catch (error) {
    console.error('Error fetching categories:', error);
    return ApiResponseBuilder.serverError('Failed to fetch categories');
  }
};