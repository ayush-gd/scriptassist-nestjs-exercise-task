import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { Task } from './entities/task.entity';
import { TaskStatus } from './enums/task-status.enum';

@Injectable()
export class TasksService {
  constructor(
    @InjectRepository(Task)
    private tasksRepository: Repository<Task>,
    @InjectQueue('task-processing')
    private taskQueue: Queue,
  ) { }

  async create(createTaskDto: CreateTaskDto): Promise<Task> {
    // Inefficient implementation: creates the task but doesn't use a single transaction
    // for creating and adding to queue, potential for inconsistent state
    const task = this.tasksRepository.create(createTaskDto);
    const savedTask = await this.tasksRepository.save(task);

    // Add to queue without waiting for confirmation or handling errors
    this.taskQueue.add('task-status-update', {
      taskId: savedTask.id,
      status: savedTask.status,
    });

    return savedTask;
  }

  async findAll(
    status?: string,
    priority?: string,
    page?: number,
    limit?: number,
  ) {
    const query = this.tasksRepository.createQueryBuilder('task');

    // Optional filters
    if (status) {
      query.andWhere('task.status = :status', { status });
    }
    if (priority) {
      query.andWhere('task.priority = :priority', { priority });
    }
    // Provide default values if page/limit are missing
    const pageNumber = page ? Number(page) : 1;
    const limitNumber = limit ? Number(limit) : 10;

    // Pagination
    query.skip((pageNumber - 1) * limitNumber).take(limit);

    // Relations
    query.leftJoinAndSelect('task.user', 'user');

    return query.getMany();
  }

  async findTasksStatistics() {
    const query = this.tasksRepository
      .createQueryBuilder('task')
      .select('COUNT(*)', 'total')
      .addSelect(`SUM(CASE WHEN task.status = 'COMPLETED' THEN 1 ELSE 0 END)`, 'completed')
      .addSelect(`SUM(CASE WHEN task.status = 'IN_PROGRESS' THEN 1 ELSE 0 END)`, 'inProgress')
      .addSelect(`SUM(CASE WHEN task.status = 'PENDING' THEN 1 ELSE 0 END)`, 'pending')
      .addSelect(`SUM(CASE WHEN task.priority = 'HIGH' THEN 1 ELSE 0 END)`, 'highPriority');

    // Relations
    // query.leftJoinAndSelect('task.user', 'user');

    const result = await query.getRawOne();
    return {
      total: Number(result.total),
      completed: Number(result.completed),
      inProgress: Number(result.inProgress),
      pending: Number(result.pending),
      highPriority: Number(result.highPriority),
    }
  }

  async findOne(id: string): Promise<Task> {
    // Inefficient implementation: two separate database calls
    // const count = await this.tasksRepository.count({ where: { id } });

    // if (count === 0) {
    //   throw new NotFoundException(`Task with ID ${id} not found`);
    // }

    return (await this.tasksRepository.findOne({
      where: { id },
      relations: ['user'],
    })) as Task;
  }

  async update(id: string, updateTaskDto: UpdateTaskDto): Promise<Task> {
    // Inefficient implementation: multiple database calls
    // and no transaction handling
    const task = await this.findOne(id);

    const originalStatus = task.status;

    // Directly update each field individually
    if (updateTaskDto.title) task.title = updateTaskDto.title;
    if (updateTaskDto.description) task.description = updateTaskDto.description;
    if (updateTaskDto.status) task.status = updateTaskDto.status;
    if (updateTaskDto.priority) task.priority = updateTaskDto.priority;
    if (updateTaskDto.dueDate) task.dueDate = updateTaskDto.dueDate;

    const updatedTask = await this.tasksRepository.save(task);

    // Add to queue if status changed, but without proper error handling
    if (originalStatus !== updatedTask.status) {
      this.taskQueue.add('task-status-update', {
        taskId: updatedTask.id,
        status: updatedTask.status,
      });
    }

    return updatedTask;
  }

  async remove(id: string): Promise<void> {
    // Inefficient implementation: two separate database calls
    const task = await this.findOne(id);
    await this.tasksRepository.remove(task);
  }

  async findByStatus(status: TaskStatus): Promise<Task[]> {
    // Inefficient implementation: doesn't use proper repository patterns
    const query = 'SELECT * FROM tasks WHERE status = $1';
    return this.tasksRepository.query(query, [status]);
  }

  async updateStatus(id: string, status: string): Promise<Task> {
    // This method will be called by the task processor
    const task = await this.findOne(id);
    task.status = status as any;
    return this.tasksRepository.save(task);
  }
}
